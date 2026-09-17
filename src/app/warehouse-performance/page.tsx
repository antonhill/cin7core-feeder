"use client";

import { useEffect, useState, useTransition } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { WAREHOUSE_PERFORMANCE_MODULE } from "@/app/module-nav";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import {
  getWarehousePerformanceDashboardAction,
  getReviewDetailAction,
  saveMetricResultAction,
  finalizeReviewAction,
  listReviewHistoryAction,
  listBottleneckOrdersAction,
  listCorrectiveActionsAction,
  createCorrectiveActionAction,
  completeCorrectiveActionAction,
  type DashboardSummary,
  type ReviewDetail,
  type ReviewHistoryEntry,
  type BottleneckOrderRow,
  type CorrectiveActionRow,
} from "./actions";
import type { ScoreStatus } from "@/scorecard/types";

const STATUS_LABEL: Record<ScoreStatus, string> = {
  strong: "Strong",
  acceptable: "Acceptable",
  needs_attention: "Needs Attention",
  serious_weakness: "Serious Weakness",
  critical: "Critical",
  not_scored: "Not Scored",
};

const STATUS_BADGE_TONE: Record<ScoreStatus, BadgeTone> = {
  strong: "success",
  acceptable: "success",
  needs_attention: "warning",
  serious_weakness: "danger",
  critical: "danger",
  not_scored: "neutral",
};

const QUEUE_LABEL: Record<string, string> = {
  ready_to_pick: "Ready to Pick",
  packed_not_invoiced: "Packed but Not Invoiced",
  invoiced_not_shipped: "Invoiced but Not Shipped",
  backorders_awaiting_stock: "Backorders Awaiting Stock",
};

function StatusBadge({ status }: { status: ScoreStatus }) {
  return <Badge tone={STATUS_BADGE_TONE[status]}>{STATUS_LABEL[status]}</Badge>;
}

function ScoreText({ score }: { score: number | null }) {
  return <span className="tabular-nums">{score === null ? "—" : score.toFixed(2)}</span>;
}

type Tab = "overview" | "review" | "bottlenecks" | "actions" | "history";
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Current Score" },
  { value: "review", label: "KPI Review" },
  { value: "bottlenecks", label: "Bottleneck Queues" },
  { value: "actions", label: "Actions" },
  { value: "history", label: "History" },
];

export default function WarehousePerformancePage() {
  const [tab, setTab] = useState<Tab>("overview");
  const [dashboard, setDashboard] = useState<DashboardSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoading] = useTransition();

  function loadDashboard() {
    startLoading(async () => {
      const res = await getWarehousePerformanceDashboardAction();
      if (!res.ok) {
        setLoadError(res.error ?? "Unknown error");
        return;
      }
      setLoadError(null);
      setDashboard(res.data ?? null);
    });
  }

  useEffect(() => {
    loadDashboard();
  }, []);

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-12">
      <ModuleHeader module={WAREHOUSE_PERFORMANCE_MODULE}>
        One overall Warehouse Health Score, six weighted performance areas, live bottleneck queues with order
        drill-down, and monthly review history — replacing the Excel Warehouse Review Scorecard.
      </ModuleHeader>

      {loadError && (
        <div className="mt-6">
          <Alert tone="danger">{loadError}</Alert>
        </div>
      )}

      {!loadError && (
        <nav className="mt-6 flex gap-1 border-b border-slate-200">
          {TABS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${
                tab === t.value ? "border-primary text-primary" : "border-transparent text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}

      <div className="mt-6">
        {isLoading && !dashboard && <p className="text-sm text-slate-500">Loading…</p>}
        {tab === "overview" && dashboard && <OverviewTab dashboard={dashboard} />}
        {tab === "review" && <ReviewTab onSaved={loadDashboard} />}
        {tab === "bottlenecks" && dashboard && <BottlenecksTab dashboard={dashboard} />}
        {tab === "actions" && <ActionsTab />}
        {tab === "history" && <HistoryTab />}
      </div>
    </main>
  );
}

function OverviewTab({ dashboard }: { dashboard: DashboardSummary }) {
  const overall = dashboard.currentReview;
  return (
    <div className="flex flex-col gap-6">
      <Panel>
        <PanelTitle>Warehouse Health — {overall?.reviewPeriod.slice(0, 7) ?? "current period"}</PanelTitle>
        <div className="mt-2 flex flex-wrap items-end gap-4">
          <p className="text-5xl font-bold tabular-nums text-slate-900">
            <ScoreText score={overall?.overallScore ?? null} /> <span className="text-2xl font-medium text-slate-400">/ 10</span>
          </p>
          {overall && <StatusBadge status={overall.status_} />}
          {overall?.status === "draft" && <Badge tone="neutral">Draft review</Badge>}
        </div>
        <p className="mt-2 text-sm text-slate-500">
          Previous month: <ScoreText score={dashboard.previousOverallScore} />
          {dashboard.changeFromPrevious !== null && (
            <span className={dashboard.changeFromPrevious >= 0 ? "ml-2 text-success" : "ml-2 text-danger"}>
              {dashboard.changeFromPrevious >= 0 ? "▲" : "▼"} {Math.abs(dashboard.changeFromPrevious).toFixed(2)}
            </span>
          )}
        </p>
      </Panel>

      <Panel>
        <PanelTitle>Headline performance</PanelTitle>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {dashboard.headlines.map((h) => (
            <div key={h.sectionId} className="rounded-lg border border-slate-200 p-4">
              <p className="text-sm font-medium text-slate-700">{h.name}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">
                <ScoreText score={h.score} />
              </p>
              <div className="mt-1">
                <StatusBadge status={h.status} />
              </div>
              <p className="mt-1 text-xs text-slate-400">{Math.round(h.weight * 100)}% weight</p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Current bottlenecks</PanelTitle>
        <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {dashboard.bottleneckSummary.map((b) => (
            <div key={b.queue} className="rounded-lg border border-slate-200 p-4">
              <p className="text-sm font-medium text-slate-700">{QUEUE_LABEL[b.queue] ?? b.queue}</p>
              <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{b.currentCount}</p>
              <p className="mt-1 text-xs text-slate-500">
                {b.oldestAgeDays !== null ? `Oldest: ${b.oldestAgeDays}d` : "—"}
                {b.outsideSlaCount !== null ? ` · ${b.outsideSlaCount} outside SLA` : ""}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Open actions</PanelTitle>
        <p className="mt-2 text-sm text-slate-700">
          <span className="font-semibold">{dashboard.openActionsCount}</span> open
          {dashboard.overdueActionsCount > 0 && <span className="ml-2 text-danger">· {dashboard.overdueActionsCount} overdue</span>}
        </p>
      </Panel>
    </div>
  );
}

function ReviewTab({ onSaved }: { onSaved: () => void }) {
  const [detail, setDetail] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingKey, setSavingKey] = useState<string | null>(null);
  const [finalizing, startFinalizing] = useTransition();

  function load() {
    getReviewDetailAction().then((res) => {
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      setError(null);
      setDetail(res.data ?? null);
    });
  }

  useEffect(load, []);

  async function handleSave(metricDefinitionId: string, score: string, comment: string, owner: string) {
    setSavingKey(metricDefinitionId);
    const parsed = score.trim() === "" ? null : Number(score);
    const res = await saveMetricResultAction(detail!.reviewId, metricDefinitionId, { score: parsed, comment: comment || null, owner: owner || null });
    setSavingKey(null);
    if (!res.ok) {
      setError(res.error ?? "Unknown error");
      return;
    }
    load();
  }

  function handleFinalize() {
    if (!detail) return;
    startFinalizing(async () => {
      const res = await finalizeReviewAction(detail.reviewId);
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      load();
      onSaved();
    });
  }

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!detail) return <p className="text-sm text-slate-500">Loading…</p>;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-slate-600">
          {detail.reviewPeriod.slice(0, 7)} · <Badge tone={detail.status === "final" ? "success" : "neutral"}>{detail.status === "final" ? "Final" : "Draft"}</Badge>
        </p>
        {detail.status === "draft" && (
          <Button onClick={handleFinalize} loading={finalizing}>
            Finalise review
          </Button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-left text-sm">
          <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">KPI</th>
              <th className="px-3 py-2">Target</th>
              <th className="px-3 py-2">Source</th>
              <th className="px-3 py-2">Score</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Comment</th>
              <th className="px-3 py-2">Owner</th>
            </tr>
          </thead>
          <tbody>
            {detail.metrics.map((m) => (
              <MetricRow key={m.metricDefinitionId} metric={m} readOnly={detail.status === "final"} saving={savingKey === m.metricDefinitionId} onSave={handleSave} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function MetricRow({
  metric,
  readOnly,
  saving,
  onSave,
}: {
  metric: ReviewDetail["metrics"][number];
  readOnly: boolean;
  saving: boolean;
  onSave: (metricDefinitionId: string, score: string, comment: string, owner: string) => void;
}) {
  const [score, setScore] = useState(metric.score?.toString() ?? "");
  const [comment, setComment] = useState(metric.comment ?? "");
  const [owner, setOwner] = useState(metric.owner ?? "");

  return (
    <tr className="border-t border-slate-100 align-top">
      <td className="px-3 py-2">
        <p className="font-medium text-slate-900">{metric.name}</p>
        <p className="text-xs text-slate-400">{metric.category}</p>
        {metric.sourceNote && <p className="mt-1 text-xs text-slate-400 italic">{metric.sourceNote}</p>}
      </td>
      <td className="px-3 py-2 text-slate-600">{metric.targetText ?? "—"}</td>
      <td className="px-3 py-2 text-xs text-slate-500">
        {metric.evidenceSource === "AUTOMATED" ? "Auto" : "Manual"} · {metric.scoringMethod === "RULE" ? "Rule" : "Reviewer"}
      </td>
      <td className="px-3 py-2">
        {readOnly ? (
          <ScoreText score={metric.score} />
        ) : (
          <input
            type="number"
            min={0}
            max={10}
            step={0.1}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            className="w-16 rounded border border-slate-300 px-2 py-1 text-sm"
          />
        )}
      </td>
      <td className="px-3 py-2">
        <StatusBadge status={metric.status} />
      </td>
      <td className="px-3 py-2">
        {readOnly ? (
          <span className="text-slate-600">{metric.comment ?? "—"}</span>
        ) : (
          <input value={comment} onChange={(e) => setComment(e.target.value)} className="w-40 rounded border border-slate-300 px-2 py-1 text-sm" />
        )}
      </td>
      <td className="px-3 py-2">
        {readOnly ? (
          <span className="text-slate-600">{metric.owner ?? "—"}</span>
        ) : (
          <div className="flex items-center gap-2">
            <input value={owner} onChange={(e) => setOwner(e.target.value)} className="w-28 rounded border border-slate-300 px-2 py-1 text-sm" />
            <Button size="sm" variant="secondary" loading={saving} onClick={() => onSave(metric.metricDefinitionId, score, comment, owner)}>
              Save
            </Button>
          </div>
        )}
      </td>
    </tr>
  );
}

function BottlenecksTab({ dashboard }: { dashboard: DashboardSummary }) {
  const [openQueue, setOpenQueue] = useState<string | null>(null);
  const [orders, setOrders] = useState<BottleneckOrderRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  function drillDown(queue: string) {
    setOpenQueue(queue);
    setOrders(null);
    setError(null);
    listBottleneckOrdersAction(queue).then((res) => {
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      setOrders(res.data ?? []);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {dashboard.bottleneckSummary.map((b) => (
          <button
            key={b.queue}
            type="button"
            onClick={() => drillDown(b.queue)}
            className="rounded-lg border border-slate-200 p-4 text-left hover:border-primary"
          >
            <p className="text-sm font-medium text-slate-700">{QUEUE_LABEL[b.queue] ?? b.queue}</p>
            <p className="mt-1 text-2xl font-bold tabular-nums text-slate-900">{b.currentCount}</p>
            <p className="mt-1 text-xs text-slate-500">
              {b.oldestAgeDays !== null ? `Oldest: ${b.oldestAgeDays}d` : "—"}
              {b.outsideSlaCount !== null ? ` · ${b.outsideSlaCount} outside SLA` : ""}
              {b.totalValue !== null ? ` · $${Math.round(b.totalValue).toLocaleString()}` : ""}
            </p>
          </button>
        ))}
      </div>

      {openQueue && (
        <Panel>
          <PanelTitle>{QUEUE_LABEL[openQueue] ?? openQueue}</PanelTitle>
          {error && <Alert tone="danger">{error}</Alert>}
          {!error && !orders && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
          {orders && orders.length === 0 && <p className="mt-2 text-sm text-slate-500">Nothing in this queue.</p>}
          {orders && orders.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="py-1.5 pr-4">Order #</th>
                    <th className="py-1.5 pr-4">Customer</th>
                    <th className="py-1.5 pr-4">Age (days)</th>
                    <th className="py-1.5 pr-4">Ship by</th>
                    <th className="py-1.5 pr-4">Qty</th>
                    <th className="py-1.5 pr-4">Open PO</th>
                  </tr>
                </thead>
                <tbody>
                  {orders.map((o) => (
                    <tr key={o.cin7SaleId} className="border-t border-slate-100">
                      <td className="py-1.5 pr-4">{o.orderNumber ?? o.cin7SaleId}</td>
                      <td className="py-1.5 pr-4">{o.customerName ?? "—"}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{o.ageDays ?? "—"}</td>
                      <td className="py-1.5 pr-4">{o.shipBy ?? "—"}</td>
                      <td className="py-1.5 pr-4 tabular-nums">{o.relevantQty ?? "—"}</td>
                      <td className="py-1.5 pr-4">{o.hasOpenPo ? "Yes" : "No"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </div>
  );
}

function ActionsTab() {
  const [actions, setActions] = useState<CorrectiveActionRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [owner, setOwner] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [creating, startCreating] = useTransition();

  function load() {
    listCorrectiveActionsAction().then((res) => {
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      setActions(res.data ?? []);
    });
  }

  useEffect(load, []);

  function handleCreate() {
    if (!title.trim()) return;
    startCreating(async () => {
      const res = await createCorrectiveActionAction({ title, owner: owner || null, dueDate: dueDate || null });
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      setTitle("");
      setOwner("");
      setDueDate("");
      load();
    });
  }

  async function handleComplete(id: string) {
    const res = await completeCorrectiveActionAction(id);
    if (!res.ok) {
      setError(res.error ?? "Unknown error");
      return;
    }
    load();
  }

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="danger">{error}</Alert>}

      <Panel>
        <PanelTitle>New corrective action</PanelTitle>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <input placeholder="Title" value={title} onChange={(e) => setTitle(e.target.value)} className="w-64 rounded border border-slate-300 px-2 py-1.5 text-sm" />
          <input placeholder="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} className="w-40 rounded border border-slate-300 px-2 py-1.5 text-sm" />
          <input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="rounded border border-slate-300 px-2 py-1.5 text-sm" />
          <Button onClick={handleCreate} loading={creating} disabled={!title.trim()}>
            Add action
          </Button>
        </div>
      </Panel>

      <Panel>
        <PanelTitle>Open Warehouse Actions</PanelTitle>
        {!actions && <p className="mt-2 text-sm text-slate-500">Loading…</p>}
        {actions && actions.length === 0 && <p className="mt-2 text-sm text-slate-500">No actions yet.</p>}
        {actions && actions.length > 0 && (
          <ul className="mt-3 flex flex-col gap-2">
            {actions.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-lg border border-slate-200 p-3">
                <div>
                  <p className="font-medium text-slate-900">{a.title}</p>
                  <p className="text-xs text-slate-500">
                    {a.owner ?? "Unassigned"} {a.dueDate ? `· due ${a.dueDate}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {a.overdue && <Badge tone="danger">Overdue</Badge>}
                  <Badge tone={a.status === "completed" ? "success" : "neutral"}>{a.status === "completed" ? "Completed" : "Open"}</Badge>
                  {a.status === "open" && (
                    <Button size="sm" variant="secondary" onClick={() => handleComplete(a.id)}>
                      Mark complete
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

function HistoryTab() {
  const [history, setHistory] = useState<ReviewHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listReviewHistoryAction().then((res) => {
      if (!res.ok) {
        setError(res.error ?? "Unknown error");
        return;
      }
      setHistory(res.data ?? []);
    });
  }, []);

  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!history) return <p className="text-sm text-slate-500">Loading…</p>;

  const maxScore = Math.max(1, ...history.map((h) => h.overallScore ?? 0));

  return (
    <Panel>
      <PanelTitle>Monthly Warehouse Health Score</PanelTitle>
      <div className="mt-4 flex flex-col gap-2">
        {history
          .slice()
          .reverse()
          .map((h) => (
            <div key={h.reviewId} className="flex items-center gap-3">
              <span className="w-16 shrink-0 text-xs text-slate-500">{h.reviewPeriod.slice(0, 7)}</span>
              <div className="h-4 flex-1 rounded bg-slate-100">
                {h.overallScore !== null && (
                  <div className="h-4 rounded bg-primary" style={{ width: `${(h.overallScore / maxScore) * 100}%` }} />
                )}
              </div>
              <span className="w-16 shrink-0 text-right text-xs tabular-nums text-slate-600">
                <ScoreText score={h.overallScore} />
              </span>
              <Badge tone={h.status === "final" ? "success" : "neutral"}>{h.status === "final" ? "Final" : "Draft"}</Badge>
            </div>
          ))}
        {history.length === 0 && <p className="text-sm text-slate-500">No reviews yet.</p>}
      </div>
    </Panel>
  );
}
