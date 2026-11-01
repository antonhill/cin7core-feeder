"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { ModuleHeader } from "@/app/ModuleHeader";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/Table";
import { claimActionPlan } from "@/lib/projects/claim-actions";
import { previewKey, previewState } from "@/lib/projects/preview-staleness";
import { claimNextStep } from "@/lib/projects/claim-next-step";
import { formatBps, formatCents, type ProjectView, type StageView } from "@/lib/projects/project-view";
import { VariationsPanel } from "./VariationsPanel";
import { OpeningCommitmentsPanel } from "./OpeningCommitmentsPanel";
import { DeliveryAllocationPanel } from "./DeliveryAllocationPanel";
import { ApprovalHistory } from "@/components/ApprovalHistory";
import { Cin7PostingPanel } from "./Cin7PostingPanel";
import { Cin7SaleCreationPanel } from "./Cin7SaleCreationPanel";
import { PhysicalPanel } from "./PhysicalPanel";
import { ProcurementPanel } from "./ProcurementPanel";
import { ProfitabilityPanel } from "./ProfitabilityPanel";
import { ProjectOverview } from "./ProjectOverview";
import {
  approveClaimAction,
  cancelDraftClaimAction,
  createClaimDraftAction,
  getProjectAction,
  getViewerPermissionsAction,
  previewClaimAction,
  recalculateStaleDraftAction,
  recordProgressAction,
  submitClaimForApprovalAction,
  type ClaimPreviewResult,
} from "../actions";

type ViewerPermission = "loading" | "member" | "admin";
type Tab = "overview" | "stages" | "components" | "claims" | "variations" | "deliveries" | "physical" | "procurement" | "profitability";
const NEWQUIP_ONLY_TABS: Tab[] = ["variations", "deliveries", "physical", "procurement"];
const TABS: { value: Tab; label: string }[] = [
  { value: "overview", label: "Overview" },
  { value: "stages", label: "Stages" },
  { value: "components", label: "Components / scope" },
  { value: "claims", label: "Commercial / Claims" },
  { value: "variations", label: "Variations" },
  { value: "deliveries", label: "Deliveries" },
  { value: "physical", label: "Products & Stock" },
  { value: "procurement", label: "Procurement / Cost Targets" },
  { value: "profitability", label: "Profitability" },
];

const CLAIM_TONE: Record<string, BadgeTone> = {
  DRAFT: "neutral", READY_FOR_APPROVAL: "info", APPROVED: "primary", CIN7_PENDING: "warning", CIN7_CREATED: "success",
  RECONCILED: "success", FAILED_UNCERTAIN: "danger", FAILED_CONFIRMED_NO_WRITE: "neutral", CANCELLED_BEFORE_WRITE: "neutral",
};

type BarTone = "sky" | "indigo" | "emerald";
const BAR_FILL: Record<BarTone, string> = { sky: "bg-sky-500", indigo: "bg-indigo-500", emerald: "bg-emerald-500" };
const BAR_TEXT: Record<BarTone, string> = { sky: "text-sky-700", indigo: "text-indigo-700", emerald: "text-emerald-700" };

/** Display-only meter for a basis-point percentage (never used for money maths). */
function Meter({ bps, tone, className = "w-20" }: { bps: number; tone: BarTone; className?: string }) {
  const pct = Math.max(0, Math.min(100, bps / 100));
  return (
    <span className={`block h-1.5 overflow-hidden rounded-full bg-slate-200/80 ${className}`} aria-hidden>
      <span className={`block h-full rounded-full ${BAR_FILL[tone]}`} style={{ width: `${pct}%` }} />
    </span>
  );
}

function PctCell({ bps, tone }: { bps: number; tone: BarTone }) {
  return (
    <span className="flex items-center justify-end gap-2.5">
      <Meter bps={bps} tone={tone} className="w-14" />
      <span className={`w-11 text-right font-semibold tabular-nums ${BAR_TEXT[tone]}`}>{formatBps(bps)}</span>
    </span>
  );
}

function Kpi({ label, value, hint, accent = false }: { label: string; value: string; hint?: string; accent?: boolean }) {
  return (
    <div
      className={`rounded-2xl border p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04),0_12px_28px_-18px_rgba(15,23,42,0.25)] ${
        accent ? "border-indigo-200 bg-gradient-to-br from-indigo-50 to-white" : "border-slate-200 bg-white"
      }`}
    >
      <p className={`text-[11px] font-semibold uppercase tracking-wider ${accent ? "text-indigo-700" : "text-slate-500"}`}>{label}</p>
      <p className={`mt-2 whitespace-nowrap text-2xl font-bold tabular-nums tracking-tight ${accent ? "text-indigo-900" : "text-slate-900"}`}>{value}</p>
      {hint && <p className="mt-1 text-xs leading-snug text-slate-500">{hint}</p>}
    </div>
  );
}

/** Contract bar for the hero: share of the revised contract that is invoiced/committed, claimable now, and not yet approved for billing. */
function ContractBar({ contract, committed, claimable }: { contract: number; committed: number; claimable: number }) {
  const share = (n: number) => (contract > 0 ? Math.max(0, Math.min(100, (n / contract) * 100)) : 0);
  const committedPct = share(committed);
  const claimablePct = Math.min(share(claimable), 100 - committedPct);
  return (
    <div className="flex h-3 w-full overflow-hidden rounded-full bg-white/15" role="img" aria-label="Contract value split into invoiced / committed, claimable now and not yet approved for billing">
      <div className="h-full bg-emerald-400" style={{ width: `${committedPct}%` }} />
      <div className="h-full bg-amber-300" style={{ width: `${claimablePct}%` }} />
    </div>
  );
}

function LegendDot({ className, label, value }: { className: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className={`h-2.5 w-2.5 rounded-full ${className}`} aria-hidden />
      <span className="text-sm text-indigo-100">{label}</span>
      <span className="text-sm font-semibold tabular-nums text-white">{value}</span>
    </div>
  );
}

/**
 * The whole project workspace. `embedded` renders a variation's internal billing scope INSIDE its original project's Variations tab (managers
 * operate its progress, claims, Cin7 Sale and invoices there, without navigating to the internal project): no page chrome, and no tabs that only
 * make sense on a top-level project. All permission checks still happen server-side in each action.
 */
export function ProjectWorkspace({ id, embedded = false }: { id: string; embedded?: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<ProjectView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>(embedded ? "stages" : "overview");
  const [preview, setPreview] = useState<ClaimPreviewResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Which billing stages the next claim covers. Empty by default: a claim never silently includes every claimable stage.
  const [chosen, setChosen] = useState<string[]>([]);
  const [previewedIds, setPreviewedIds] = useState<string[]>([]);
  // Optional partial amount (rands) per chosen stage; blank = the full claimable amount.
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [previewedAmounts, setPreviewedAmounts] = useState<Record<string, string>>({});
  const [previewShownKey, setPreviewShownKey] = useState<string | null>(null);
  const [isLoading, startLoading] = useTransition();
  const [isWorking, startWorking] = useTransition();

  function load() {
    startLoading(async () => {
      const res = await getProjectAction(id);
      // An internal variation billing scope is not for ordinary users: send them to the project it belongs to.
      if (!res.ok && res.redirectTo && !embedded) return router.replace(`/projects/${res.redirectTo}`);
      if (!res.ok) return setError(res.error ?? "Unknown error");
      setError(null);
      setView(res.data ?? null);
    });
  }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- load is re-created every render; it only needs to re-run when the project id changes
  useEffect(load, [id]);
  // Display only: every mutating action re-checks the owner/admin role on the server.
  // LOADING until known, so privileged controls (and the non-admin explanation) never flash; any failure => MEMBER (fail closed).
  const [perm, setPerm] = useState<ViewerPermission>("loading");
  const [newquip, setNewquip] = useState(false); // NewQuip-only tabs (Variations, Products & Fulfilment); hidden until the server confirms
  useEffect(() => {
    getViewerPermissionsAction().then((r) => { setPerm(r.ok && r.data?.canApprove ? "admin" : "member"); setNewquip(Boolean(r.ok && r.data?.newquip)); });
  }, []);

  /** Resolves true only when the action succeeded (forms use this to reset themselves; a failure keeps their input). */
  function run(fn: () => Promise<{ ok: boolean; error?: string }>, done?: string): Promise<boolean> {
    return new Promise((resolve) => {
      startWorking(async () => {
        const res = await fn();
        if (!res.ok) {
          setError(res.error ?? "Unknown error");
          return resolve(false);
        }
        setError(null);
        setNotice(done ?? null);
        setPreview(null);
        load();
        resolve(true);
      });
    });
  }

  function doPreview() {
    startWorking(async () => {
      const res = await previewClaimAction(id, chosen, amounts);
      if (!res.ok) {
        setPreview(null);
        return setPreviewError(res.error ?? "Unknown error");
      }
      setPreviewError(null);
      setPreview(res.data ?? null);
      setPreviewedIds(chosen);
      setPreviewedAmounts(amounts);
      setPreviewShownKey(view ? previewKey(view) : null);
    });
  }

  if (!view) {
    return embedded ? (
      <div className="mt-4">{error ? <Alert tone="danger">{error}</Alert> : <p className="text-sm text-slate-500">{isLoading ? "Loading the variation billing workspace…" : ""}</p>}</div>
    ) : (
      <main className="mx-auto w-full max-w-[1480px] px-6 py-12">
        <ModuleHeader module={PROJECTS_MODULE}>{isLoading ? "Loading project…" : "Project"}</ModuleHeader>
        {error && <div className="mt-6"><Alert tone="danger">{error}</Alert></div>}
      </main>
    );
  }
  const { project, commercial: c } = view;
  const pvState = previewState(previewShownKey, previewKey(view));

  const Shell = embedded ? "div" : "main";
  return (
    <Shell className={embedded ? "mt-2" : "mx-auto w-full max-w-[1480px] px-6 py-12"}>
      {!embedded && (
        <ModuleHeader module={PROJECTS_MODULE}>
          <Link href="/projects" className="text-indigo-700 hover:underline">← All projects</Link>
          {" · "}
          {project.project_reference} — {project.name}
        </ModuleHeader>
      )}

      {error && <div className="mt-6"><Alert tone="danger">{error}</Alert></div>}
      {!embedded && view.project.billing_scope === "VARIATION" && view.project.parent_project_id && (
        <div className="mt-6"><Alert tone="info">This is the internal billing scope of a variation, not a separate project: its contract is part of the original project&apos;s revised contract. <Link className="underline" href={`/projects/${view.project.parent_project_id}`}>Open the project</Link>.</Alert></div>
      )}
      {notice && <div className="mt-6"><Alert tone="success">{notice}</Alert></div>}
      {c.uncertainClaimBlocking && (
        <div className="mt-6">
          <Alert tone="warning">A claim has an uncertain Cin7 outcome. Its value stays reserved and billing of its stages is blocked until it is reconciled.</Alert>
        </div>
      )}
      {!c.scheduleBalanced && (
        <div className="mt-6"><Alert tone="danger">Stage values do not reconcile to the contract value — claiming is blocked.</Alert></div>
      )}

      <nav className="mt-6 inline-flex max-w-full gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 shadow-sm" aria-label="Project sections">
        {TABS.filter((t) => !(embedded && (t.value === "variations" || t.value === "deliveries" || t.value === "physical" || t.value === "procurement" || t.value === "profitability" || t.value === "components")) && (t.value !== "profitability" || perm === "admin") && (!NEWQUIP_ONLY_TABS.includes(t.value) || newquip)).map((t) => {
          const count = t.value === "stages" ? view.stages.length : t.value === "claims" ? view.claims.length : t.value === "variations" ? view.variations.length : null;
          return (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              aria-current={tab === t.value ? "page" : undefined}
              className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.value ? "bg-indigo-600 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
              }`}
            >
              {t.label}
              {count !== null && (
                <span className={`rounded-full px-1.5 text-xs tabular-nums ${tab === t.value ? "bg-white/20 text-white" : "bg-slate-100 text-slate-500"}`}>{count}</span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === "overview" && (
        <div className="mt-6 space-y-6">
          <section className="overflow-hidden rounded-3xl bg-gradient-to-br from-indigo-950 via-indigo-900 to-indigo-700 p-7 text-white shadow-[0_20px_40px_-24px_rgba(49,46,129,0.7)]">
            <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-md bg-white/10 px-2 py-0.5 font-mono text-xs text-indigo-100">{project.project_reference}</span>
                  <span className="rounded-md bg-emerald-400/20 px-2 py-0.5 text-xs font-semibold text-emerald-200">{project.status}</span>
                </div>
                <h2 className="mt-3 text-2xl font-bold tracking-tight sm:text-3xl">{project.name}</h2>
                <p className="mt-1 text-indigo-200">{project.customer_name}</p>
              </div>
              <div className="lg:text-right">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-200">Revised contract value (ex VAT)</p>
                <p className="mt-1 whitespace-nowrap text-4xl font-bold tabular-nums tracking-tight sm:text-5xl">{formatCents(c.revisedContractCents)}</p>
              </div>
            </div>
            <div className="mt-7">
              <ContractBar contract={c.revisedContractCents} committed={c.committedCents} claimable={c.claimableCents} />
              <div className="mt-4 flex flex-wrap gap-x-8 gap-y-2">
                <LegendDot className="bg-emerald-400" label="Invoiced / committed" value={formatCents(c.committedCents)} />
                <LegendDot className="bg-amber-300" label="Claimable now" value={formatCents(c.claimableCents)} />
                <LegendDot className="bg-white/25" label="Not yet approved for billing" value={formatCents(Math.max(0, c.revisedContractCents - c.committedCents - c.claimableCents))} />
              </div>
            </div>
          </section>

          {!embedded && newquip && <ProjectOverview projectId={id} refreshKey={previewKey(view)} onOpenTab={(t) => { setTab(t); window.scrollTo({ top: 0, behavior: "smooth" }); }} />}

          <div>
            <h2 className="mb-3 text-sm font-semibold text-slate-700">Commercial position (ex VAT)</h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
              <Kpi label="Original contract value" value={formatCents(c.originalContractCents)} />
              <Kpi label="Approved variations" value={formatCents(c.approvedVariationsCents)} hint="Approved variations only" />
              <Kpi label="Revised contract value" value={formatCents(c.revisedContractCents)} />
              <Kpi label="Approved completion" value={formatBps(c.approvedCompletionBps)} hint="Earned ÷ contract" />
              <Kpi label="Earned / certified to date" value={formatCents(c.earnedCents)} hint="Stage value × APPROVED completion" />
              <Kpi label="Invoiced / committed" value={formatCents(c.committedCents)} hint="Approved, sent or uncertain claims" />
              <Kpi label="Currently claimable" value={formatCents(c.claimableCents)} hint="Earned − invoiced / committed" accent />
              <Kpi label="Remaining to bill / commit" value={formatCents(c.remainingCents)} hint="Contract value − invoiced / committed (not − earned)" />
            </div>
          </div>

          <Panel>
            <PanelTitle>Project details</PanelTitle>
            <dl className="mt-4 grid grid-cols-1 gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-4">
              {[
                ["Customer", project.customer_name], ["Project reference", project.project_reference],
                ["Originating quote", project.originating_quote_ref ?? "—"], ["Salesperson", project.salesperson ?? "—"],
                ["Project manager", project.project_manager ?? "—"], ["Start date", project.start_date ?? "—"],
                ["Target completion", project.target_completion_date ?? "—"], ["Status", project.status],
                ["Tax", `${project.tax_rule ?? "—"} (${formatBps(project.tax_rate_bps)})`],
              ].map(([k, v]) => (
                <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-0.5 font-medium text-slate-900">{v}</dd></div>
              ))}
            </dl>
          </Panel>
        </div>
      )}

      {tab === "stages" && (
        <div className="mt-6 space-y-6">
          <section aria-label="What the three progress measures mean" className="grid gap-3 md:grid-cols-3">
            {[
              { tone: "sky" as const, title: "Physical progress", text: "What the team reports on site. Informational only." },
              { tone: "indigo" as const, title: "Commercial approval", text: "What a manager has approved for billing. Only this drives a claim." },
              { tone: "emerald" as const, title: "Billed / committed", text: "What claims already hold, including approved and uncertain claims." },
            ].map((x) => (
              <div key={x.title} className="flex gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${BAR_FILL[x.tone]}`} aria-hidden />
                <div>
                  <p className={`text-sm font-semibold ${BAR_TEXT[x.tone]}`}>{x.title}</p>
                  <p className="mt-0.5 text-xs leading-snug text-slate-600">{x.text}</p>
                </div>
              </div>
            ))}
          </section>
          <p className="sr-only">
            Three different things, deliberately not one &ldquo;% complete&rdquo;. Only commercial approval drives a claim.
          </p>

          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04),0_14px_30px_-20px_rgba(15,23,42,0.3)]">
            <table className="w-full min-w-[1180px] border-separate border-spacing-0 text-sm">
              <thead>
                <tr className="text-[11px] font-semibold uppercase tracking-wider">
                  <th className="sticky left-0 z-10 bg-white" />
                  <th colSpan={2} className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-right text-slate-500">Contract</th>
                  <th className="border-b border-sky-100 bg-sky-50 px-3 py-2 text-right text-sky-700">Physical</th>
                  <th colSpan={2} className="border-b border-indigo-100 bg-indigo-50 px-3 py-2 text-right text-indigo-700">Commercial</th>
                  <th colSpan={2} className="border-b border-emerald-100 bg-emerald-50 px-3 py-2 text-right text-emerald-700">Billed</th>
                  <th colSpan={2} className="border-b border-slate-200 bg-slate-50 px-3 py-2 text-right text-slate-500">Position</th>
                </tr>
                <tr className="text-[11px] font-semibold uppercase tracking-wider text-slate-600">
                  <th className="sticky left-0 z-10 border-b-2 border-slate-300 bg-white px-3 py-3 text-left">Stage</th>
                  <th className="leading-tight border-b-2 border-slate-300 bg-slate-50 px-3 py-3 text-right">Value</th>
                  <th className="leading-tight border-b-2 border-slate-300 bg-slate-50 px-3 py-3 text-right">% of contract</th>
                  <th className="leading-tight border-b-2 border-sky-200 bg-sky-50 px-3 py-3 text-right text-sky-800">Physical (reported)</th>
                  <th className="leading-tight border-b-2 border-indigo-200 bg-indigo-50 px-3 py-3 text-right text-indigo-800">Commercial approval</th>
                  <th className="leading-tight border-b-2 border-indigo-200 bg-indigo-50 px-3 py-3 text-right text-indigo-800">Earned to date</th>
                  <th className="leading-tight border-b-2 border-emerald-200 bg-emerald-50 px-3 py-3 text-right text-emerald-800">Billed / committed</th>
                  <th className="leading-tight border-b-2 border-emerald-200 bg-emerald-50 px-3 py-3 text-right text-emerald-800">Billed % of stage</th>
                  <th className="leading-tight border-b-2 border-slate-300 bg-slate-50 px-3 py-3 text-right">Currently claimable</th>
                  <th className="leading-tight border-b-2 border-slate-300 bg-slate-50 px-3 py-3 text-right">Remaining to bill / commit</th>
                </tr>
              </thead>
              <tbody>
                {view.stages.map((s) => (
                  <tr key={s.id} className="group transition-colors hover:bg-indigo-50/40">
                    <td className="sticky left-0 z-10 min-w-[190px] border-b border-slate-100 bg-white px-3 py-3.5 font-medium text-slate-900 group-hover:bg-indigo-50/40">
                      {s.name}
                      {s.belowCommitted && <span className="ml-2 align-middle"><Badge tone="warning">approval below billed</Badge></span>}
                    </td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3.5 text-right tabular-nums">{formatCents(s.valueCents)}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3.5 text-right tabular-nums text-slate-500">{formatBps(s.shareBps)}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 bg-sky-50/30 px-3 py-3.5"><PctCell bps={s.reportedBps} tone="sky" /></td>
                    <td className="whitespace-nowrap border-b border-slate-100 bg-indigo-50/30 px-3 py-3.5"><PctCell bps={s.approvedBps} tone="indigo" /></td>
                    <td className="whitespace-nowrap border-b border-slate-100 bg-indigo-50/30 px-3 py-3.5 text-right tabular-nums">{formatCents(s.earnedCents)}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 bg-emerald-50/30 px-3 py-3.5 text-right tabular-nums">{formatCents(s.committedCents)}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 bg-emerald-50/30 px-3 py-3.5"><PctCell bps={s.committedBps} tone="emerald" /></td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3.5 text-right">
                      {s.claimableCents > 0 ? (
                        <span className="inline-block rounded-lg bg-indigo-600 px-2.5 py-1 text-sm font-semibold tabular-nums text-white shadow-sm">{formatCents(s.claimableCents)}</span>
                      ) : (
                        <span className="tabular-nums text-slate-400">{formatCents(s.claimableCents)}</span>
                      )}
                    </td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-3 py-3.5 text-right tabular-nums">{formatCents(s.remainingCents)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold text-slate-900">
                  <td className="sticky left-0 z-10 bg-slate-50 px-3 py-3.5">Project total</td>
                  <td className="whitespace-nowrap bg-slate-50 px-3 py-3.5 text-right tabular-nums">{formatCents(c.originalContractCents)}</td>
                  <td className="bg-slate-50 px-3 py-3.5" />
                  <td className="bg-slate-50 px-3 py-3.5" />
                  <td className="whitespace-nowrap bg-slate-50 px-3 py-3.5 text-right tabular-nums text-indigo-700">{formatBps(c.approvedCompletionBps)}</td>
                  <td className="whitespace-nowrap bg-slate-50 px-3 py-3.5 text-right tabular-nums">{formatCents(c.earnedCents)}</td>
                  <td className="whitespace-nowrap bg-slate-50 px-3 py-3.5 text-right tabular-nums">{formatCents(c.committedCents)}</td>
                  <td className="bg-slate-50 px-3 py-3.5" />
                  <td className="whitespace-nowrap bg-slate-50 px-3 py-3.5 text-right tabular-nums text-indigo-700">{formatCents(c.claimableCents)}</td>
                  <td className="whitespace-nowrap bg-slate-50 px-3 py-3.5 text-right tabular-nums">{formatCents(c.remainingCents)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-slate-500">Scroll the table sideways on narrow screens — the stage name stays in view.</p>

          <h2 className="text-sm font-semibold text-slate-700">Update progress by stage</h2>
          <div className="grid gap-4 xl:grid-cols-2">
            {view.stages.map((s, i) => (
              <ProgressForm
                key={s.id}
                index={i + 1}
                stage={s}
                disabled={isWorking}
                perm={perm}
                onPhysical={(reported, comment) => run(() => recordProgressAction(id, s.id, reported, null, comment), `Physical progress recorded for ${s.name}. Commercial approval and claims are unchanged.`)}
                onCommercial={(approved, comment) => run(() => recordProgressAction(id, s.id, (s.reportedBps / 100).toString(), approved, comment), `Commercial approval recorded for ${s.name}. Nothing was claimed or sent to Cin7.`)}
              />
            ))}
          </div>
        </div>
      )}

      {tab === "components" && (
        <div className="mt-6 space-y-4">
          <div className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
            <span className="mt-0.5 h-2 w-2 shrink-0 rounded-full bg-sky-500" aria-hidden />
            <p className="text-sm text-sky-900">
              <span className="font-semibold">Scope allocation is for visibility and later cost control.</span> It never determines the amount of a progress claim — the Schedule of Values does.
            </p>
          </div>
          <div className="flex items-baseline justify-between">
            <h2 className="text-base font-semibold text-slate-900">Components / scope</h2>
            <p className="text-xs text-slate-500">{view.allocations.length} line{view.allocations.length === 1 ? "" : "s"}</p>
          </div>
          <Table>
            <THead><tr><TH>SKU / description</TH><TH align="right">Qty</TH><TH align="right">Sales value</TH><TH align="right">Estimated cost</TH><TH>Allocated stage</TH></tr></THead>
            <TBody>
              {view.allocations.length === 0 && <TR><TD>No scope lines.</TD></TR>}
              {view.allocations.map((a) => {
                const stageName = view.stages.find((s) => s.id === a.stage_id)?.name;
                return (
                  <TR key={a.id}>
                    <TD>
                      {a.sku ? <span className="mr-2 rounded-md bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700">{a.sku}</span> : null}
                      <span className="font-medium text-slate-900">{a.description}</span>
                    </TD>
                    <TD align="right" className="tabular-nums whitespace-nowrap">{a.quantity}</TD>
                    <TD align="right" className="tabular-nums whitespace-nowrap font-medium">{formatCents(a.sales_value_cents)}</TD>
                    <TD align="right" className="tabular-nums whitespace-nowrap text-slate-600">{a.estimated_cost_cents === null ? "—" : formatCents(a.estimated_cost_cents)}</TD>
                    <TD className="whitespace-nowrap">
                      {stageName ? <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">{stageName}</span> : <span className="text-slate-400">Unallocated</span>}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </div>
      )}

      {tab === "deliveries" && newquip && (
        <div>
          <Alert tone="info">Deliveries are a logistics plan. Planning a delivery does not move stock in Cin7 and does not decide what can be invoiced; invoicing is controlled on the Commercial / Claims tab.</Alert>
          <DeliveryAllocationPanel view={view} section="deliveries" />
        </div>
      )}
      {tab === "physical" && newquip && <PhysicalPanel view={view} />}
      {tab === "procurement" && newquip && <ProcurementPanel view={view} />}
      {tab === "profitability" && perm === "admin" && <ProfitabilityPanel view={view} />}

      {tab === "variations" && newquip && <VariationsPanel view={view} isAdmin={perm === "admin"} run={run} working={isWorking} />}

      {tab === "claims" && (
        <div className="mt-6 space-y-6">
          <OpeningCommitmentsPanel key={`${view.openingCommitments.length}-${view.claims.length}`} view={view} isAdmin={perm === "admin"} run={run} working={isWorking} />
          <Cin7SaleCreationPanel view={view} run={run} working={isWorking} />
          <Cin7PostingPanel view={view} run={run} working={isWorking} />
          <Panel>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <PanelTitle>Create progress claim</PanelTitle>
                <p className="mt-1 text-sm text-slate-500">Preview first. Creating a claim saves a local draft only — it does not create anything in Cin7.</p>
              </div>
              <span className="whitespace-nowrap rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600">Not sent to Cin7</span>
            </div>
            <fieldset className="mt-4 rounded-lg border border-slate-200 p-3">
              <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-500">Billing stages to include</legend>
              <div className="space-y-1">
                {view.stages.map((s) => {
                  const ok = s.claimableCents > 0;
                  return (
                    <label key={s.id} className={`flex items-center gap-3 text-sm ${ok ? "text-slate-800" : "text-slate-400"}`}>
                      <input type="checkbox" disabled={!ok} checked={chosen.includes(s.id)} onChange={(e) => { setChosen((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id))); if (!e.target.checked) setAmounts((m) => { const n = { ...m }; delete n[s.id]; return n; }); setPreview(null); setPreviewError(null); }} />
                      <span className="flex-1">{s.name}</span>
                      {ok && chosen.includes(s.id) && (
                        <input aria-label={`Amount to claim for ${s.name} (rands, blank = all)`} placeholder="all" inputMode="decimal" className="h-7 w-28 rounded border border-slate-300 px-2 text-right tabular-nums text-slate-900"
                          value={amounts[s.id] ?? ""} onChange={(e) => { setAmounts((m) => ({ ...m, [s.id]: e.target.value })); setPreview(null); setPreviewError(null); }} />
                      )}
                      <span className="tabular-nums">{ok ? `${formatCents(s.claimableCents)} claimable` : s.remainingCents === 0 ? "fully committed" : "nothing claimable yet"}</span>
                    </label>
                  );
                })}
              </div>
              {chosen.length === 0 && <p className="mt-2 text-xs text-slate-500">Tick the stage(s) this claim covers, for example only the deposit. To claim less than the full amount, enter it beside the stage; leave it blank to claim everything claimable.</p>}
            </fieldset>
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={doPreview} loading={isWorking} disabled={chosen.length === 0 || (!!preview && pvState === "CURRENT")}>{!preview ? "Preview claim" : pvState === "STALE" ? "Refresh preview" : "Preview is up to date"}</Button>
              {preview && (
                <Button size="sm" onClick={() => run(() => createClaimDraftAction(id, previewedIds, previewedAmounts), "Draft claim saved locally.")} loading={isWorking} disabled={pvState === "STALE"}>Save as draft claim</Button>
              )}
            </div>
            {previewError && <div className="mt-3"><Alert tone="warning">{previewError}</Alert></div>}
            {preview && pvState === "STALE" && <div className="mt-3"><Alert tone="warning">This preview is out of date: the project changed after it was calculated. Refresh the preview before saving a draft.</Alert></div>}
            {preview && (
              <div className="mt-5 space-y-4">
                <p className="text-sm font-medium text-slate-700">Claim {preview.claimNumber} <span className="font-normal text-slate-500">· preview only, nothing saved yet</span></p>
                <div className="grid gap-3 sm:grid-cols-3">
                  <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-indigo-700">Currently claimable (ex VAT)</p>
                    <p className="mt-2 whitespace-nowrap text-3xl font-bold tabular-nums tracking-tight text-indigo-900">{formatCents(preview.calc.subtotalCents)}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">VAT ({formatBps(preview.taxRateBps)})</p>
                    <p className="mt-2 whitespace-nowrap text-2xl font-bold tabular-nums tracking-tight text-slate-900">{formatCents(preview.calc.taxCents)}</p>
                  </div>
                  <div className="rounded-2xl border border-slate-200 bg-white p-5">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500">Total (inc VAT)</p>
                    <p className="mt-2 whitespace-nowrap text-2xl font-bold tabular-nums tracking-tight text-slate-900">{formatCents(preview.calc.totalCents)}</p>
                  </div>
                </div>
                <Table>
                  <THead><tr><TH>Stage</TH><TH align="right">Stage value</TH><TH align="right">Approved %</TH><TH align="right">Earned to date</TH><TH align="right">Previously billed / committed</TH><TH align="right">This claim</TH></tr></THead>
                  <TBody>
                    {preview.calc.lines.map((l) => (
                      <TR key={l.stageId}>
                        <TD className="font-medium text-slate-900">{l.stageName}</TD>
                        <TD align="right" className="tabular-nums whitespace-nowrap">{formatCents(l.stageValueCents)}</TD>
                        <TD align="right" className="tabular-nums whitespace-nowrap font-semibold text-indigo-700">{formatBps(l.approvedBps)}</TD>
                        <TD align="right" className="tabular-nums whitespace-nowrap">{formatCents(l.earnedToDateCents)}</TD>
                        <TD align="right" className="tabular-nums whitespace-nowrap text-slate-600">{formatCents(l.previouslyBilledCents)} ({formatBps(l.previouslyBilledBps)})</TD>
                        <TD align="right" className="tabular-nums whitespace-nowrap bg-indigo-50/60 font-bold text-indigo-900">{formatCents(l.currentClaimCents)}</TD>
                      </TR>
                    ))}
                  </TBody>
                </Table>
              </div>
            )}
          </Panel>

          <div>
            <div className="mb-2 flex items-baseline justify-between">
              <h2 className="text-base font-semibold text-slate-900">Claim history</h2>
              <p className="text-xs text-slate-500">{view.claims.length} claim{view.claims.length === 1 ? "" : "s"}</p>
            </div>
            {view.claims.length === 0 && <p className="rounded-lg border border-dashed border-slate-300 p-4 text-sm text-slate-500">No claims yet.</p>}
            <div className="grid gap-3 lg:grid-cols-2">
              {view.claims.map((cl) => {
                const plan = claimActionPlan(cl, perm === "admin" ? "admin" : perm === "member" ? "member" : "none");
                return (
                  <article key={cl.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
                    <header className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <h3 className="text-base font-semibold text-slate-900">{cl.claim_number}</h3>
                        <p className="text-xs text-slate-500">{cl.claim_date}{cl.supersedes_claim_id ? ` · supersedes ${view.claims.find((x) => x.id === cl.supersedes_claim_id)?.claim_number ?? "an earlier draft"}` : ""}</p>
                      </div>
                      <div className="text-right">
                        <p className="whitespace-nowrap text-xl font-bold tabular-nums text-slate-900">{formatCents(cl.total_cents)}</p>
                        <p className="whitespace-nowrap text-xs tabular-nums text-slate-500">{formatCents(cl.subtotal_cents)} ex VAT + {formatCents(cl.tax_cents)} VAT</p>
                      </div>
                    </header>
                    <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                      <div><dt className="text-slate-500">Approval</dt><dd className="mt-0.5"><Badge tone={CLAIM_TONE[cl.status] ?? "neutral"}>{cl.status.replace(/_/g, " ")}</Badge></dd></div>
                      <div>
                        <dt className="text-slate-500">Cin7</dt>
                        <dd className="mt-0.5">
                          <Badge tone={cl.cin7Status.tone}>{cl.cin7Status.label}</Badge>
                          {cl.cin7Status.invoiceNumber && <span className="ml-1 text-slate-600">{cl.cin7Status.invoiceNumber}{cl.cin7Status.reconciled ? " · reconciled" : ""}</span>}
                        </dd>
                      </div>
                      <div className="col-span-2">
                        <dt className="text-slate-500">Value</dt>
                        <dd className="mt-0.5">{cl.reserves ? <span className="font-medium text-indigo-700">{cl.status === "FAILED_UNCERTAIN" ? "Stays reserved (outcome uncertain)" : "Reserves value"}</span> : <span className="text-slate-500">No reservation</span>}</dd>
                      </div>
                    </dl>
                    <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-700"><span className="font-medium text-slate-900">Next: </span>{claimNextStep({ status: cl.status, cin7Kind: cl.cin7Status.kind, stageRole: cl.approval?.stageRole, canApproveHere: plan.approveHere, canAct: perm !== "loading" })}</p>
                    {cl.cin7Status.detail && !["DRAFT_CREATED", "AUTHORISED"].includes(cl.cin7Status.kind) && <p className="mt-2 text-xs text-slate-500">{cl.cin7Status.detail}</p>}
                    <div className="mt-3">
                      <div className="flex flex-wrap items-center gap-1">
                            {plan.submit && <Button size="sm" variant="secondary" onClick={() => run(() => submitClaimForApprovalAction(id, cl.id), "Claim submitted for approval.")} disabled={isWorking}>Submit</Button>}
                            {plan.openInApprovals && cl.approval && <Link href={`/approvals/${cl.approval.requestId}`} className="inline-flex h-8 items-center rounded-md border border-indigo-200 bg-indigo-50 px-3 text-xs font-medium text-indigo-800 hover:bg-indigo-100">Open in Approvals</Link>}
                            {plan.approveHere && <Button size="sm" onClick={() => run(() => approveClaimAction(id, cl.id), "Claim approved — value reserved. Nothing was sent to Cin7.")} disabled={isWorking}>Approve</Button>}
                            {plan.waitingText && <span className="self-center text-xs text-slate-500">{plan.waitingText}</span>}
                            {plan.recalculate && <Button size="sm" variant="secondary" onClick={() => run(() => recalculateStaleDraftAction(id, cl.id), "Recalculated: a new draft was created and the old one superseded.")} disabled={isWorking}>Recalculate</Button>}
                            {plan.cancel && <Button size="sm" variant="ghost" onClick={() => run(() => cancelDraftClaimAction(id, cl.id), cl.status === "READY_FOR_APPROVAL" ? "Claim withdrawn." : "Claim cancelled.")} disabled={isWorking}>{plan.cancelLabel}</Button>}
                          </div>
                    </div>
                    <details className="mt-3 text-xs">
                      <summary className="cursor-pointer text-slate-600">Approval history</summary>
                      <div className="mt-1"><ApprovalHistory docType="CLAIM" docId={cl.id} label="Approval history" /></div>
                    </details>
                  </article>
                );
              })}
            </div>
          </div>
          {newquip && !embedded && (
            <div>
              <Alert tone="info">Milestone confirmation records contractual evidence that a billing milestone was met. It is independent of physical delivery: a deposit or an authorised early invoice never needs goods to have moved.</Alert>
              <DeliveryAllocationPanel view={view} section="milestones" />
            </div>
          )}
        </div>
      )}
    </Shell>
  );
}

function ProgressForm({
  index,
  stage,
  disabled,
  perm,
  onPhysical,
  onCommercial,
}: {
  index: number;
  stage: StageView;
  disabled: boolean;
  perm: ViewerPermission;
  /** Resolve true on success: the form then clears its comment and collapses. A failure leaves everything as typed. */
  onPhysical: (reported: string, comment: string) => Promise<boolean>;
  onCommercial: (approved: string, comment: string) => Promise<boolean>;
}) {
  const currentReported = (stage.reportedBps / 100).toString();
  const currentApproved = (stage.approvedBps / 100).toString();
  const [reported, setReported] = useState(currentReported);
  const [approved, setApproved] = useState(currentApproved);
  const [comment, setComment] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Inputs restart from the latest saved values every time the form is opened (after a save, or if someone else changed the stage).
  function toggle() {
    if (!open) {
      setReported(currentReported);
      setApproved(currentApproved);
    }
    setOpen(!open);
  }

  async function finish(save: Promise<boolean>) {
    if (await save) {
      setComment("");
      setLocalError(null);
      setOpen(false);
    }
  }

  function submitCommercial() {
    if (approved === currentApproved) return setLocalError("Enter a different approved percentage to record an approval.");
    if (!comment.trim()) return setLocalError("A reason is required when approved commercial completion changes.");
    setLocalError(null);
    void finish(onCommercial(approved, comment));
  }

  return (
    <Panel>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-bold text-indigo-700">{index}</span>
          <p className="truncate text-sm font-semibold text-slate-900">{stage.name}</p>
        </div>
        <Button size="sm" variant={open ? "ghost" : "secondary"} onClick={toggle}>{open ? "Hide" : "Update progress"}</Button>
      </div>
      <div className="mt-4 grid grid-cols-3 gap-4">
        {([
          ["Physical", stage.reportedBps, "sky"],
          ["Commercial approval", stage.approvedBps, "indigo"],
          ["Billed / committed", stage.committedBps, "emerald"],
        ] as const).map(([label, bps, tone]) => (
          <div key={label}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[11px] font-medium uppercase tracking-wide text-slate-500">{label}</span>
              <span className={`text-sm font-semibold tabular-nums ${BAR_TEXT[tone]}`}>{formatBps(bps)}</span>
            </div>
            <Meter bps={bps} tone={tone} className="mt-1.5 w-full" />
          </div>
        ))}
      </div>
      {open && (
        <div className="mt-3 space-y-4">
          <Input label="Comment / reason" value={comment} onChange={(e) => setComment(e.target.value)} helperText="Optional for physical progress; required for a commercial approval." />
          <div className="space-y-2 rounded-md border border-sky-200 bg-sky-50/40 p-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-800">Report physical progress</p>
            <Input label={`Physical completion (%) — now ${formatBps(stage.reportedBps)}`} value={reported} onChange={(e) => setReported(e.target.value)} inputMode="decimal" />
            <p className="text-xs text-slate-500">Informational. Does not change commercial approval and never creates or changes a claim.</p>
            <Button size="sm" variant="secondary" disabled={disabled || reported === currentReported} onClick={() => { setLocalError(null); void finish(onPhysical(reported, comment)); }}>Record physical progress</Button>
          </div>
          {perm === "admin" ? (
            <div className="space-y-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-indigo-800">Approve commercial progress (owner/admin)</p>
              <Input label={`Approved commercial completion (%) — now ${formatBps(stage.approvedBps)}, physical ${formatBps(stage.reportedBps)}`} value={approved} onChange={(e) => setApproved(e.target.value)} inputMode="decimal" />
              <p className="text-xs text-slate-500">This is the only completion that drives a claim. Recording it creates no claim and sends nothing to Cin7.</p>
              <Button size="sm" disabled={disabled} onClick={submitCommercial}>Approve commercial progress</Button>
            </div>
          ) : perm === "member" ? (
            <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">Commercial approval is set by an organisation owner or admin.</p>
          ) : null}
          {localError && <Alert tone="warning">{localError}</Alert>}
        </div>
      )}
      {stage.history.length > 0 && (
        <details className="mt-3 text-xs text-slate-600">
          <summary className="cursor-pointer">Progress history ({stage.history.length})</summary>
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
