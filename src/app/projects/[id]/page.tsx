"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { formatBps, formatCents, type ProjectView, type StageView } from "@/lib/projects/project-view";
import {
  approveClaimAction,
  cancelDraftClaimAction,
  createClaimDraftAction,
  getProjectAction,
  previewClaimAction,
  recalculateStaleDraftAction,
  recordProgressAction,
  submitClaimForApprovalAction,
  type ClaimPreviewResult,
} from "../actions";

type Tab = "overview" | "stages" | "components" | "claims";
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "stages", label: "Stages" },
  { value: "components", label: "Components / scope" },
  { value: "claims", label: "Claims" },
];

const CLAIM_TONE: Record<string, BadgeTone> = {
  DRAFT: "neutral", READY_FOR_APPROVAL: "info", APPROVED: "primary", CIN7_PENDING: "warning", CIN7_CREATED: "success",
  RECONCILED: "success", FAILED_UNCERTAIN: "danger", FAILED_CONFIRMED_NO_WRITE: "neutral", CANCELLED_BEFORE_WRITE: "neutral",
};

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [view, setView] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");
  const [preview, setPreview] = useState<ClaimPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoading, startLoading] = useTransition();
  const [isWorking, startWorking] = useTransition();

  function load() {
    startLoading(async () => {
      const res = await getProjectAction(id);
      if (!res.ok) return setError(res.error ?? "Unknown error");
      setError(null);
      setView(res.data ?? null);
    });
  }
  useEffect(load, [id]);

  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string) {
    startWorking(async () => {
      const res = await fn();
      if (!res.ok) return setError(res.error ?? "Unknown error");
      setError(null);
      setNotice(done ?? null);
      setPreview(null);
      load();
    });
  }

  function doPreview() {
    startWorking(async () => {
      const res = await previewClaimAction(id);
      if (!res.ok) {
        setPreview(null);
        return setPreviewError(res.error ?? "Unknown error");
      }
      setPreviewError(null);
      setPreview(res.data ?? null);
    });
  }

  if (!view) {
    return (
      <main className="mx-auto w-full max-w-6xl px-6 py-12">
        <ModuleHeader module={PROJECTS_MODULE}>{isLoading ? "Loading project…" : "Project"}</ModuleHeader>
        {error && <div className="mt-6"><Alert tone="danger">{error}</Alert></div>}
      </main>
    );
  }
  const { project, commercial: c } = view;

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <ModuleHeader module={PROJECTS_MODULE}>
        <Link href="/projects" className="text-indigo-700 hover:underline">← All projects</Link>
        {" · "}
        {project.project_reference} — {project.name}
      </ModuleHeader>

      {error && <div className="mt-6"><Alert tone="danger">{error}</Alert></div>}
      {notice && <div className="mt-6"><Alert tone="success">{notice}</Alert></div>}
      {c.uncertainClaimBlocking && (
        <div className="mt-6">
          <Alert tone="warning">A claim has an uncertain Cin7 outcome. Its value stays reserved and billing of its stages is blocked until it is reconciled.</Alert>
        </div>
      )}
      {!c.scheduleBalanced && (
        <div className="mt-6"><Alert tone="danger">Stage values do not reconcile to the contract value — claiming is blocked.</Alert></div>
      )}

      <nav className="mt-6 flex gap-1 border-b border-slate-200" aria-label="Project sections">
        {TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            aria-current={tab === t.value ? "page" : undefined}
            className={`px-4 py-2 text-sm font-medium ${tab === t.value ? "border-b-2 border-indigo-600 text-indigo-700" : "text-slate-500 hover:text-slate-800"}`}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "overview" && (
        <div className="mt-6 space-y-6">
          <Panel>
            <PanelTitle>Project</PanelTitle>
            <dl className="mt-3 grid grid-cols-1 gap-x-8 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {[
                ["Customer", project.customer_name], ["Project reference", project.project_reference],
                ["Originating quote", project.originating_quote_ref ?? "—"], ["Salesperson", project.salesperson ?? "—"],
                ["Project manager", project.project_manager ?? "—"], ["Start date", project.start_date ?? "—"],
                ["Target completion", project.target_completion_date ?? "—"], ["Status", project.status],
                ["Tax", `${project.tax_rule ?? "—"} (${formatBps(project.tax_rate_bps)})`],
              ].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="font-medium text-slate-900">{v}</dd></div>
              ))}
            </dl>
          </Panel>
          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Commercial position (ex VAT)</h2>
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat label="Original contract value" value={formatCents(c.originalContractCents)} />
              <Stat label="Approved variations" value={formatCents(c.approvedVariationsCents)} hint="Variations are out of POC scope" />
              <Stat label="Revised contract value" value={formatCents(c.revisedContractCents)} />
              <Stat label="Approved completion" value={formatBps(c.approvedCompletionBps)} hint="Earned ÷ contract" />
              <Stat label="Earned / certified to date" value={formatCents(c.earnedCents)} hint="Stage value × APPROVED completion" />
              <Stat label="Invoiced / committed" value={formatCents(c.committedCents)} hint="Approved, sent or uncertain claims" />
              <Stat label="Currently claimable" value={formatCents(c.claimableCents)} />
              <Stat label="Remaining contract value" value={formatCents(c.remainingCents)} />
            </div>
          </div>
        </div>
      )}

      {tab === "stages" && (
        <div className="mt-6 space-y-4">
          <Alert tone="info">
            Three different things, deliberately not one &ldquo;% complete&rdquo;: <strong>Physical progress</strong> is what the team reports on site;
            <strong> Commercial approval</strong> is what a manager has approved for billing; <strong>Billed / committed</strong> is what claims already hold.
            Only commercial approval drives a claim.
          </Alert>
          <Table>
            <THead>
              <tr>
                <TH className="bg-slate-50" >Stage</TH>
                <TH align="right">Value</TH>
                <TH align="right">% of contract</TH>
                <TH align="right" className="bg-sky-50 text-sky-800">Physical progress (reported)</TH>
                <TH align="right" className="bg-indigo-50 text-indigo-800">Commercial approval</TH>
                <TH align="right" className="bg-indigo-50 text-indigo-800">Earned to date</TH>
                <TH align="right" className="bg-emerald-50 text-emerald-800">Billed / committed</TH>
                <TH align="right" className="bg-emerald-50 text-emerald-800">Billed % of stage</TH>
                <TH align="right">Currently claimable</TH>
                <TH align="right">Remaining</TH>
              </tr>
            </THead>
            <TBody>
              {view.stages.map((s) => (
                <TR key={s.id}>
                  <TD>{s.name}{s.belowCommitted && <span className="ml-2"><Badge tone="warning">approval below billed</Badge></span>}</TD>
                  <TD align="right" className="tabular-nums">{formatCents(s.valueCents)}</TD>
                  <TD align="right" className="tabular-nums">{formatBps(s.shareBps)}</TD>
                  <TD align="right" className="bg-sky-50/40 tabular-nums">{formatBps(s.reportedBps)}</TD>
                  <TD align="right" className="bg-indigo-50/40 tabular-nums">{formatBps(s.approvedBps)}</TD>
                  <TD align="right" className="bg-indigo-50/40 tabular-nums">{formatCents(s.earnedCents)}</TD>
                  <TD align="right" className="bg-emerald-50/40 tabular-nums">{formatCents(s.committedCents)}</TD>
                  <TD align="right" className="bg-emerald-50/40 tabular-nums">{formatBps(s.committedBps)}</TD>
                  <TD align="right" className="font-semibold tabular-nums">{formatCents(s.claimableCents)}</TD>
                  <TD align="right" className="tabular-nums">{formatCents(s.remainingCents)}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="grid gap-4 lg:grid-cols-2">
            {view.stages.map((s) => (
              <ProgressForm key={s.id} stage={s} disabled={isWorking} onSubmit={(rep, app, comment) => run(() => recordProgressAction(id, s.id, rep, app, comment), `Progress recorded for ${s.name}.`)} />
            ))}
          </div>
        </div>
      )}

      {tab === "components" && (
        <div className="mt-6 space-y-3">
          <Alert tone="info">Scope allocation is for visibility and later cost control. It never determines the amount of a progress claim — the Schedule of Values does.</Alert>
          <Table>
            <THead><tr><TH>SKU / description</TH><TH align="right">Qty</TH><TH align="right">Sales value</TH><TH align="right">Estimated cost</TH><TH>Allocated stage</TH></tr></THead>
            <TBody>
              {view.allocations.map((a) => (
                <TR key={a.id}>
                  <TD>{a.sku ? <span className="font-mono text-xs">{a.sku}</span> : null} {a.description}</TD>
                  <TD align="right" className="tabular-nums">{a.quantity}</TD>
                  <TD align="right" className="tabular-nums">{formatCents(a.sales_value_cents)}</TD>
                  <TD align="right" className="tabular-nums">{a.estimated_cost_cents === null ? "—" : formatCents(a.estimated_cost_cents)}</TD>
                  <TD>{view.stages.find((s) => s.id === a.stage_id)?.name ?? "—"}</TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </div>
      )}

      {tab === "claims" && (
        <div className="mt-6 space-y-6">
          <Panel>
            <PanelTitle>Create progress claim</PanelTitle>
            <p className="mt-1 text-sm text-slate-500">Preview first. Creating a claim saves a local draft only — it does not create anything in Cin7.</p>
            <div className="mt-3 flex gap-2">
              <Button variant="secondary" size="sm" onClick={doPreview} loading={isWorking}>Preview claim</Button>
              {preview && (
                <Button size="sm" onClick={() => run(() => createClaimDraftAction(id), "Draft claim saved locally.")} loading={isWorking}>Save as draft claim</Button>
              )}
            </div>
            {previewError && <div className="mt-3"><Alert tone="warning">{previewError}</Alert></div>}
            {preview && (
              <div className="mt-4 space-y-3">
                <p className="text-sm font-medium text-slate-700">Claim {preview.claimNumber}</p>
                <Table>
                  <THead><tr><TH>Stage</TH><TH align="right">Stage value</TH><TH align="right">Approved %</TH><TH align="right">Earned to date</TH><TH align="right">Previously billed / committed</TH><TH align="right">This claim</TH></tr></THead>
                  <TBody>
                    {preview.calc.lines.map((l) => (
                      <TR key={l.stageId}>
                        <TD>{l.stageName}</TD>
                        <TD align="right" className="tabular-nums">{formatCents(l.stageValueCents)}</TD>
                        <TD align="right" className="tabular-nums">{formatBps(l.approvedBps)}</TD>
                        <TD align="right" className="tabular-nums">{formatCents(l.earnedToDateCents)}</TD>
                        <TD align="right" className="tabular-nums">{formatCents(l.previouslyBilledCents)} ({formatBps(l.previouslyBilledBps)})</TD>
                        <TD align="right" className="font-semibold tabular-nums">{formatCents(l.currentClaimCents)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
                <dl className="ml-auto grid max-w-xs grid-cols-2 gap-1 text-sm">
                  <dt className="text-slate-500">Current claim (ex VAT)</dt><dd className="text-right font-semibold tabular-nums">{formatCents(preview.calc.subtotalCents)}</dd>
                  <dt className="text-slate-500">VAT ({formatBps(preview.taxRateBps)})</dt><dd className="text-right tabular-nums">{formatCents(preview.calc.taxCents)}</dd>
                  <dt className="text-slate-500">Total</dt><dd className="text-right font-semibold tabular-nums">{formatCents(preview.calc.totalCents)}</dd>
                </dl>
              </div>
            )}
          </Panel>

          <div>
            <h2 className="mb-2 text-sm font-semibold text-slate-700">Claim history</h2>
            <Table>
              <THead><tr><TH>Claim #</TH><TH>Date</TH><TH>Financial status</TH><TH align="right">Ex VAT</TH><TH align="right">VAT</TH><TH align="right">Total</TH><TH>Cin7</TH><TH>Actions</TH></tr></THead>
              <TBody>
                {view.claims.length === 0 && <TR><TD>No claims yet.</TD></TR>}
                {view.claims.map((cl) => (
                  <TR key={cl.id}>
                    <TD>
                      {cl.claim_number}
                      {cl.supersedes_claim_id && <span className="ml-2 text-xs text-slate-500">supersedes {view.claims.find((x) => x.id === cl.supersedes_claim_id)?.claim_number ?? "an earlier draft"}</span>}
                    </TD>
                    <TD>{cl.claim_date}</TD>
                    <TD>
                      <Badge tone={CLAIM_TONE[cl.status] ?? "neutral"}>{cl.status}</Badge>
                      <span className="ml-2 text-xs text-slate-500">{cl.reserves ? "reserves value" : "no reservation"}</span>
                    </TD>
                    <TD align="right" className="tabular-nums">{formatCents(cl.subtotal_cents)}</TD>
                    <TD align="right" className="tabular-nums">{formatCents(cl.tax_cents)}</TD>
                    <TD align="right" className="tabular-nums">{formatCents(cl.total_cents)}</TD>
                    <TD>{cl.cin7 ? `${cl.cin7.cin7_invoice_number ?? "—"} (${cl.cin7.cin7_status ?? "—"})` : "Not sent to Cin7"}</TD>
                    <TD>
                      <div className="flex gap-1">
                        {cl.status === "DRAFT" && <Button size="sm" variant="secondary" onClick={() => run(() => submitClaimForApprovalAction(id, cl.id), "Claim submitted for approval.")} disabled={isWorking}>Submit</Button>}
                        {cl.status === "READY_FOR_APPROVAL" && <Button size="sm" onClick={() => run(() => approveClaimAction(id, cl.id), "Claim approved — value reserved. Nothing was sent to Cin7.")} disabled={isWorking}>Approve</Button>}
                        {(cl.status === "DRAFT" || cl.status === "READY_FOR_APPROVAL") && <Button size="sm" variant="secondary" onClick={() => run(() => recalculateStaleDraftAction(id, cl.id), "Recalculated: a new draft was created and the old one superseded.")} disabled={isWorking}>Recalculate</Button>}
                        {(cl.status === "DRAFT" || cl.status === "READY_FOR_APPROVAL") && <Button size="sm" variant="ghost" onClick={() => run(() => cancelDraftClaimAction(id, cl.id), "Claim cancelled.")} disabled={isWorking}>Cancel</Button>}
                      </div>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </div>
        </div>
      )}
    </main>
  );
}

function ProgressForm({ stage, disabled, onSubmit }: { stage: StageView; disabled: boolean; onSubmit: (reported: string, approved: string | null, comment: string) => void }) {
  const [reported, setReported] = useState((stage.reportedBps / 100).toString());
  const [approved, setApproved] = useState((stage.approvedBps / 100).toString());
  const [comment, setComment] = useState("");
  const [open, setOpen] = useState(false);
  const approvedChanged = approved !== (stage.approvedBps / 100).toString();
  return (
    <Panel>
      <div className="flex items-center justify-between">
        <PanelTitle>{stage.name}</PanelTitle>
        <Button size="sm" variant="ghost" onClick={() => setOpen(!open)}>{open ? "Hide" : "Update progress"}</Button>
      </div>
      {open && (
        <div className="mt-3 space-y-3">
          <Input label="Reported physical completion (%)" value={reported} onChange={(e) => setReported(e.target.value)} inputMode="decimal" />
          <Input label="Approved commercial completion (%) — manager only" value={approved} onChange={(e) => setApproved(e.target.value)} inputMode="decimal" helperText="Leave unchanged to record physical progress only." />
          <Input label="Comment / reason" value={comment} onChange={(e) => setComment(e.target.value)} helperText={approvedChanged ? "Required when approved completion changes." : undefined} />
          <Button size="sm" disabled={disabled} onClick={() => onSubmit(reported, approvedChanged ? approved : null, comment)}>Record progress</Button>
        </div>
      )}
      {stage.history.length > 0 && (
        <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer">History ({stage.history.length})</summary>
          <ul className="mt-2 space-y-1">
            {stage.history.map((h) => (
              <li key={h.id}>
                {h.created_at.slice(0, 16).replace("T", " ")} · {h.recorded_by_email} · physical {formatBps(h.previous_reported_bps ?? 0)}→{formatBps(h.reported_bps)} · approved {formatBps(h.previous_approved_bps ?? 0)}→{formatBps(h.approved_bps)}{h.comment ? ` — ${h.comment}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </Panel>
  );
}
