"use client";

import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { formatSast } from "@/lib/approvals/time";
import { QUOTE_TYPE_LABEL } from "@/newquip/grower/pricing-source";
import { CHARGE_LABEL, type ChargeKey } from "@/newquip/grower/quote-bridge";
import type { QuoteDraft } from "@/newquip/grower/draft";
import type { FinalReviewItem } from "@/newquip/quote/stage23-wizard";
import type { WizardRole } from "@/newquip/quote/wizard-contract";
import { fmtCents, fmtZar } from "../fields";

// Read-only presentation for Stages 2 and 3 (UX-006i2): the Rep's submitted information as a compact summary, the Final review checklist and the Estimator's result for the Manager. Everything
// here is derived from facts the page already holds; nothing edits, saves or authorises anything, and nothing imports a server action or a store. Cost and margin appear only where the page
// passes them, which it does only for a viewer with cost visibility.

const OPTIONAL_NAMES: Record<string, string> = {
  controller: "Thomas-CL1 controller", silo_weighing: "Silo weighing", control_panel: "Control panel", emergency_windows: "Emergency windows", pad_cooling: "Pad cooling", cone_fans: "Cone fans", manure_plug: "Manure plugs",
};
const MARK = (met: boolean) => <span aria-hidden className={`inline-flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-bold ${met ? "border-emerald-700 bg-emerald-700 text-white" : "border-amber-600 bg-amber-50 text-amber-900"}`}>{met ? "✓" : "!"}</span>;

/** The owner of the next action, as a small tag. */
export function OwnerTag({ role }: { role: WizardRole | null }) {
  return role ? <span className="rounded-md border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs font-semibold text-slate-800" data-testid="next-owner">{role}</span> : null;
}

export interface RepSummaryProps {
  draft: QuoteDraft;
  /** The quotation is with the Estimator (or later): what the Rep submitted. Otherwise it is the Rep's work in progress. */
  submitted: boolean;
  revision: number;
  floorAreaM2: number | null;
  totalCents: number | null;
  quantities: ReadonlyArray<{ label: string; qty: number }>;
  confirmed: { cents: number | null; by: string | null; at: string | null };
}

/** "Submitted by the Rep": headline facts always visible, the detail collapsible. Read-only, shown once at the top of Stage 2 (and in the Manager's workspace). */
export function RepSubmittedSummary({ draft, submitted, revision, floorAreaM2, totalCents, quantities, confirmed }: RepSummaryProps) {
  const cfg = draft.config;
  const extras = Object.entries(cfg.optionalEquipment).filter(([, on]) => on).map(([k]) => OPTIONAL_NAMES[k] ?? k);
  const excluded = Object.entries(cfg.exclusions ?? {});
  const charges = (["delivery", "installation", "concrete_slat_delivery"] as ChargeKey[]).map((c) => [CHARGE_LABEL[c], draft.estimator.charges[c]] as const).filter(([, v]) => v != null);
  const m75 = draft.estimator.unitPrices.flex_auger;
  const conf = confirmed.cents != null
    ? `${fmtCents(confirmed.cents)} confirmed by ${confirmed.by?.trim() || "the customer contact"}${confirmed.at ? ` on ${formatSast(confirmed.at)}` : ""}`
    : null;
  const room = cfg.lengthM && cfg.widthM ? `${cfg.lengthM} m × ${cfg.widthM} m${floorAreaM2 == null ? "" : ` (${Math.round(floorAreaM2 * 1000) / 1000} m²)`} · ${cfg.rooms || 0} rooms` : "—";
  return (
    <section aria-label={submitted ? "Submitted by the Rep" : "From the Rep (not submitted yet)"} data-testid="rep-summary" className="mt-4 rounded-lg border border-slate-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-semibold text-slate-900">{submitted ? "Submitted by the Rep" : "From the Rep (not submitted yet)"}</h2>
        <span className="text-xs text-slate-700">Read-only · revision {revision}</span>
      </div>
      <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4">
        <div><dt className="text-xs text-slate-700">Customer</dt><dd className="break-words font-medium text-slate-900">{draft.customerName.trim() || "—"}</dd></div>
        <div><dt className="text-xs text-slate-700">Site</dt><dd className="break-words font-medium text-slate-900">{draft.siteName.trim() || "—"}</dd></div>
        <div><dt className="text-xs text-slate-700">{submitted ? "Submitted total (ex VAT)" : "Quote total (ex VAT)"}</dt><dd className="font-medium tabular-nums text-slate-900" data-testid="rep-summary-total">{totalCents == null ? "—" : fmtCents(totalCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Customer price confirmation</dt><dd className="font-medium text-slate-900" data-testid="rep-summary-confirmation">{conf ?? <span className="text-slate-700">Not recorded yet</span>}</dd></div>
      </dl>
      <details className="mt-3" data-testid="rep-summary-detail">
        <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-indigo-700">Show the submitted detail</summary>
        <div className="mt-2 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          <div><h3 className="text-sm font-semibold text-slate-900">Site &amp; measurements</h3>
            <p className="mt-1 text-sm text-slate-800">{QUOTE_TYPE_LABEL[draft.quoteType]} pricing · {room}</p>
            <p className="text-sm text-slate-800">{cfg.totalPens || 0} pens ({cfg.hospitalPens || 0} hospital) · {cfg.pigsPerRoom || 0} pigs per room</p></div>
          <div><h3 className="text-sm font-semibold text-slate-900">Selected equipment</h3>
            <p className="mt-1 text-sm text-slate-800">Feeder: {cfg.feederVariant === "WINDOW" ? "with window" : "standard"} · Penning: {cfg.penningPigSize ? cfg.penningPigSize.toLowerCase() : "not chosen"}</p>
            <p className="text-sm text-slate-800">{extras.length ? `Included: ${extras.join(", ")}` : "No optional equipment included"}</p></div>
          <div><h3 className="text-sm font-semibold text-slate-900">Quantities (whole project)</h3>
            <p className="mt-1 text-sm text-slate-800">{quantities.length ? quantities.map((q) => `${q.label} ${q.qty}`).join(" · ") : "—"}</p></div>
          <div><h3 className="text-sm font-semibold text-slate-900">Charges</h3>
            <p className="mt-1 text-sm text-slate-800">{charges.length || m75 != null ? [...charges.map(([k, v]) => `${k} ${fmtZar(v as number)}`), ...(m75 != null ? [`M75 system ${fmtZar(m75)}`] : [])].join(" · ") : "—"}</p>
            {draft.estimator.assumptions.trim() && <p className="text-sm text-slate-800">Assumptions: {draft.estimator.assumptions}</p>}</div>
          <div><h3 className="text-sm font-semibold text-slate-900">Exclusions</h3>
            <p className="mt-1 text-sm text-slate-800">{excluded.length ? excluded.map(([k, r]) => `${k.replace(/_/g, " ")}${r.trim() ? ` (${r.trim()})` : ""}`).join(" · ") : "None"}</p></div>
        </div>
      </details>
    </section>
  );
}

/** The compact readiness checklist of the Final review step. */
export function FinalReviewChecklist({ items }: { items: FinalReviewItem[] }) {
  return (
    <ul className="mt-3 space-y-2" aria-label="Final review checklist" data-testid="final-review-checklist">
      {items.map((x) => (
        <li key={x.id} data-check={x.id} className="flex items-start gap-2 text-sm">
          {MARK(x.met)}
          <span className="min-w-0"><span className="font-medium text-slate-900">{x.label}</span>{" "}<span className={`text-xs font-semibold ${x.met ? "text-emerald-800" : "text-amber-900"}`} data-testid={`final-check-${x.id}`}>{x.met ? "Met" : "Not met"}</span>
            {x.detail && <span className="block text-xs text-slate-700">{x.detail}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

export interface EstimatorResultProps {
  signedOffBy: string | null; signedOffAt: string | null; signoffCurrent: boolean;
  totalCents: number | null; confirmedCents: number | null;
  /** Cost and margin headline: passed ONLY for a viewer with cost visibility. */
  costing: { estimatedCost: number; marginPct: number | null } | null;
  /** Manual quotation prices in use (an exception to the price source). */
  priceExceptions: ReadonlyArray<{ label: string; unitPrice: number; reason: string; by?: string; at?: string }>;
  /** Cost overrides: passed ONLY for a viewer with cost visibility. */
  costOverrides: ReadonlyArray<{ label: string; costCents: number; reason: string; by?: string }> | null;
  /** Prices and the Estimator's free-text reasons are shown ONLY to a viewer with cost visibility; anyone else sees which lines are manually priced and by whom, nothing more. */
  showPriceDetail: boolean;
  /** The margin is incomplete or unknown (cost-visible viewers only): a visible flag, never a block. */
  marginUnknown: boolean;
  /** Costed lines with no cost when the PROJECT margin is incomplete (null = complete or not shown). */
  missingCostLines: number | null;
  /** The three largest lines by selling value (cost-visible viewers only), so an implausible line is noticeable. */
  largestLines: ReadonlyArray<{ label: string; amount: number }> | null;
}

/** The Estimator's result as the Manager reads it: who signed off and when, the total against the confirmed amount, the costing headline and every exception. */
export function EstimatorResult(p: EstimatorResultProps) {
  const match = p.totalCents != null && p.confirmedCents != null && p.totalCents === p.confirmedCents;
  return (
    <Panel>
      <PanelTitle>Estimator result</PanelTitle>
      <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-4" data-testid="estimator-result">
        <div><dt className="text-xs text-slate-700">Signed off by</dt><dd className="font-medium text-slate-900" data-testid="result-signoff">{p.signedOffBy ? `${p.signedOffBy}${p.signedOffAt ? `, ${formatSast(p.signedOffAt)}` : ""}${p.signoffCurrent ? "" : " (out of date)"}` : <span className="text-slate-700">Not signed off yet</span>}</dd></div>
        <div><dt className="text-xs text-slate-700">Quote total (ex VAT)</dt><dd className="font-medium tabular-nums text-slate-900">{p.totalCents == null ? "—" : fmtCents(p.totalCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Customer-confirmed amount</dt><dd className="font-medium tabular-nums text-slate-900">{p.confirmedCents == null ? "—" : fmtCents(p.confirmedCents)} {p.confirmedCents != null && p.totalCents != null && <Status tone={match ? "success" : "danger"}>{match ? "Matches the total" : "Does not match the total"}</Status>}</dd></div>
        {p.marginUnknown && <div className="md:col-span-2 xl:col-span-4"><Status tone="warning">Margin: incomplete or unknown</Status> <span className="text-sm text-slate-800" data-testid="margin-flag">{p.missingCostLines ? `${p.missingCostLines} costed line${p.missingCostLines === 1 ? " has" : "s have"} no cost, so project margin is not available; the percentage shown is indicative (price-list basis). ` : "Some costs are missing, so the margin cannot be relied on. "}Look at the lines below before deciding.</span></div>}
        {p.costing && <div><dt className="text-xs text-slate-700">{p.missingCostLines ? "Estimated cost · indicative margin (price-list basis)" : "Estimated cost · gross margin"}</dt><dd className="font-medium tabular-nums text-slate-900" data-testid="result-costing">{fmtZar(p.costing.estimatedCost)} · {p.costing.marginPct == null ? "N/A" : `${p.costing.marginPct.toFixed(1)}%`}</dd></div>}
      </dl>
      <div className="mt-4" data-testid="result-exceptions">
        <h3 className="text-sm font-semibold text-slate-900">Pricing exceptions</h3>
        {p.priceExceptions.length === 0 && (!p.costOverrides || p.costOverrides.length === 0) ? <p className="mt-1 text-sm text-slate-800">None: every line is priced from the approved price source.</p> : (
          <ul className="mt-1 space-y-1 text-sm text-slate-800">
            {p.priceExceptions.map((e) => p.showPriceDetail
              ? <li key={`p:${e.label}`}><b>{e.label}</b>: manual quotation price {fmtZar(e.unitPrice)} ex VAT · {e.reason.trim() || "no reason"}{e.by ? ` · ${e.by}` : ""}{e.at ? ` at ${formatSast(e.at)}` : ""}</li>
              : <li key={`p:${e.label}`}><b>{e.label}</b>: manually priced by the Estimator</li>)}
            {(p.costOverrides ?? []).map((o) => <li key={`c:${o.label}`}><b>{o.label}</b>: cost override {fmtCents(o.costCents)} · {o.reason.trim()}{o.by ? ` · ${o.by}` : ""}</li>)}
          </ul>
        )}
      </div>
      {p.largestLines && p.largestLines.length > 0 && (
        <div className="mt-4" data-testid="largest-lines">
          <h3 className="text-sm font-semibold text-slate-900">Largest lines (ex VAT)</h3>
          <ol className="mt-1 list-decimal space-y-0.5 pl-5 text-sm text-slate-800">{p.largestLines.map((l) => <li key={l.label}>{l.label}: <b className="tabular-nums">{fmtZar(l.amount)}</b></li>)}</ol>
        </div>
      )}
    </Panel>
  );
}

/** A labelled disclosure with a one-line summary, closed by default unless something in it needs attention. Its content stays MOUNTED when closed (so the requests it makes are unchanged). */
export function Disclosure({ title, summary, attention = false, testId, children }: { title: string; summary: string; attention?: boolean; testId: string; children: React.ReactNode }) {
  return (
    <details className="rounded-lg border border-slate-200 bg-white p-3" open={attention || undefined} data-testid={testId}>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-sm font-semibold text-slate-900">{title}</span>
        <span className={`text-xs ${attention ? "font-semibold text-amber-900" : "text-slate-700"}`}>{summary}</span>
      </summary>
      <div className="mt-3 space-y-6">{children}</div>
    </details>
  );
}
