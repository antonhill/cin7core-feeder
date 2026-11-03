"use client";

import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { STEP_STATUS_LABEL } from "@/components/ui/step-rail-model";
import { QUOTE_TYPE_NEUTRAL } from "@/newquip/grower/pricing-source";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { STAGE1_STEP_IDS, STAGE1_STEP_LABEL, type Stage1CustomerFacts, type Stage1Derived, type Stage1StepId } from "@/newquip/quote/stage1-steps";
import type { WizardStep } from "@/newquip/quote/wizard-contract";

// Step 4 of Stage 1: a READ-ONLY, compact summary of the live preview of the draft, a completion indicator per step, Edit links to the step that holds each part, and the missing required
// information WITH the role that has to supply it. Nothing here edits, saves or authorises anything; the way on is the step bar's Next.
const OPTIONAL_NAMES: Record<string, string> = {
  controller: "Thomas-CL1 controller", silo_weighing: "Silo weighing", control_panel: "Control panel", emergency_windows: "Emergency windows", pad_cooling: "Pad cooling", cone_fans: "Cone fans", manure_plug: "Manure plugs",
};
const CHIP: Record<string, string> = { complete: "border-emerald-600 bg-emerald-50 text-emerald-900", attention: "border-amber-500 bg-amber-50 text-amber-900", incomplete: "border-slate-300 bg-white text-slate-700", review: "border-indigo-400 bg-indigo-50 text-indigo-900", unavailable: "border-slate-300 bg-slate-50 text-slate-700" };

export function Stage1Review({ awaiting, draft, floorAreaM2, totalLabel, derived, steps, customer, quantities, canEdit, onGoStep }: {
  draft: QuoteDraft; floorAreaM2: number | null; totalLabel: string; derived: Stage1Derived; steps: readonly WizardStep[]; customer: Stage1CustomerFacts;
  /** What is awaiting the Estimator (informational: never a Rep blocker). */ awaiting: { choices: number; prices: number; lines: number };
  /** Calculated project quantities (selected lines only). */
  quantities: ReadonlyArray<{ label: string; qty: number }>; canEdit: boolean; onGoStep: (stepId: Stage1StepId) => void;
}) {
  const cfg = draft.config;
  const extras = Object.entries(cfg.optionalEquipment).filter(([, on]) => on).map(([k]) => OPTIONAL_NAMES[k] ?? k);
  const excluded = Object.keys(cfg.exclusions ?? {});
  const stepOf = (id: Stage1StepId) => steps.find((s) => s.id === id);
  // An Edit link is offered only for a step the viewer can open AND change; otherwise nothing is offered (a reader just reads).
  const editLink = (id: Stage1StepId) => {
    const st = stepOf(id);
    if (!canEdit || !st || st.access !== "edit") return null;
    return <Button type="button" size="sm" variant="secondary" className="min-h-11" onClick={() => onGoStep(id)} aria-label={`Edit ${STAGE1_STEP_LABEL[id]}`}>Edit</Button>;
  };
  const cards: Array<{ id: Stage1StepId; rows: Array<[string, string]> }> = [
    { id: "customer", rows: [["Customer", customer.customerTitle ?? (draft.customerName.trim() || "—")], ["Quotation contact", customer.contactName ?? "not chosen"], ["Quotation sent to", customer.contactEmail ?? "—"]] },
    { id: "site", rows: [
      ["Site / project", draft.siteName.trim() || "—"], ["Pricing basis", QUOTE_TYPE_NEUTRAL[draft.quoteType]],
      ["Room", cfg.lengthM && cfg.widthM ? `${cfg.lengthM} m × ${cfg.widthM} m${floorAreaM2 == null ? "" : ` (${Math.round(floorAreaM2 * 1000) / 1000} m²)`} · ${cfg.rooms || 0} rooms` : "—"],
      ["Pens and pigs (per room)", `${cfg.totalPens || 0} pens (${cfg.hospitalPens || 0} hospital) · ${cfg.pigsPerRoom || 0} pigs`],
    ] },
    { id: "equipment", rows: [
      ["Feeder variant", cfg.feederVariant === "WINDOW" ? "With window" : "Standard"],
      ["Penning pig size", cfg.penningPigSize ? cfg.penningPigSize.charAt(0) + cfg.penningPigSize.slice(1).toLowerCase() : "not chosen"],
      ["Optional equipment", extras.length ? `Included: ${extras.join(", ")}` : "none included"],
      ["Exclusions", excluded.length ? excluded.join(", ").replace(/_/g, " ") : "none"],
    ] },
  ];
  const rep = derived.open.filter((o) => o.owner === "Rep");
  const est = derived.open.filter((o) => o.owner === "Estimator");
  const estMaps = est.filter((o) => o.message.startsWith("Estimator product choice needed:"));
  const estOther = est.filter((o) => !o.message.startsWith("Estimator product choice needed:"));
  const nextLine = rep.length > 0 ? `Next: finish ${rep.length} item${rep.length === 1 ? "" : "s"} listed below.`
    : est.length > 0 ? `Everything you can do is complete - submit to the Estimator (step 5). ${awaiting.lines || est.length} item${(awaiting.lines || est.length) === 1 ? "" : "s"} will be resolved by the Estimator afterwards.`
    : "Everything you can do is complete - submit to the Estimator (step 5).";
  return (
    <Panel className="col-span-full">
      <PanelTitle>Review configuration</PanelTitle>
      <p className="mt-1 text-sm text-slate-700 max-sm:hidden">Read-only summary of this draft. Use Edit to change a part.</p>
      <ul className="mt-3 flex flex-wrap gap-2" aria-label="Completion of the steps" data-testid="stage1-review-chips">
        {STAGE1_STEP_IDS.filter((id) => id === "customer" || id === "site" || id === "equipment").map((id, n) => {
          const st = stepOf(id)!;
          return <li key={id} className={`rounded-md border px-2 py-1 text-xs font-semibold ${CHIP[st.status]}`}>{n + 1}. {STAGE1_STEP_LABEL[id]}: {STEP_STATUS_LABEL[st.status]}</li>;
        })}
      </ul>
      <div className="mt-4 grid gap-4 md:grid-cols-3" data-testid="stage1-review-summary">
        {cards.map((c) => (
          <section key={c.id} className="min-w-0 rounded-lg border border-slate-200 p-3" aria-label={STAGE1_STEP_LABEL[c.id]}>
            <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-semibold text-slate-900">{STAGE1_STEP_LABEL[c.id]}</h3>{editLink(c.id)}</div>
            <dl className="mt-2 space-y-1 text-sm">{c.rows.map(([k, v]) => <div key={k}><dt className="text-xs text-slate-700">{k}</dt><dd className="break-words font-medium text-slate-900">{v}</dd></div>)}</dl>
          </section>
        ))}
      </div>
      {quantities.length > 0 && (
        <div className="mt-4" data-testid="stage1-review-quantities">
          <h3 className="text-sm font-semibold text-slate-900">Calculated quantities (whole project)</h3>
          <p className="mt-1 text-sm text-slate-800">{quantities.map((q) => `${q.label} ${q.qty}`).join(" · ")}</p>
        </div>
      )}
      <p className="mt-3 text-sm text-slate-800">Quote total (ex VAT, live preview): <b className="tabular-nums">{totalLabel}</b></p>
      <div className="mt-4" data-testid="stage1-review-issues">
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-medium text-slate-900" data-testid="review-next">{nextLine}</p>
        {rep.length === 0 && est.length === 0
          ? <p className="mt-3 text-sm font-medium text-emerald-800"><span aria-hidden>✓ </span>No required information is missing.</p>
          : (
            <>
              <h3 className="mt-3 text-sm font-semibold text-slate-900">Missing required information</h3>
              <ul className="mt-2 space-y-2">
                {rep.map((i) => (
                  <li key={`Rep:${i.message}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="rounded-md border border-amber-500 bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-900" data-testid="owner-tag">Rep</span>
                    <span className="text-slate-900">{i.message}</span>
                    {i.stepId && stepOf(i.stepId)?.access === "edit" && canEdit && (
                      <Button type="button" size="sm" variant="secondary" className="min-h-11" onClick={() => onGoStep(i.stepId!)}>Go to step {STAGE1_STEP_IDS.indexOf(i.stepId) + 1}: {STAGE1_STEP_LABEL[i.stepId]}</Button>
                    )}
                  </li>
                ))}
                {estMaps.length > 0 && (
                  <li className="text-sm" data-testid="est-mappings-group">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="rounded-md border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs font-semibold text-slate-800" data-testid="owner-tag">Estimator</span>
                      <span className="text-slate-900">Awaiting the Estimator: {awaiting.choices} product choice{awaiting.choices === 1 ? "" : "s"}, {awaiting.prices} price{awaiting.prices === 1 ? "" : "s"}.</span>
                    </div>
                    <details className="mt-1 pl-1 text-xs text-slate-700"><summary className="inline-flex min-h-11 cursor-pointer items-center">Show the {estMaps.length === 1 ? "item" : "list"}</summary>
                      <ul className="mt-1 list-disc pl-5">{estMaps.map((i) => <li key={i.message}>{i.message.replace(/^Estimator product choice needed: /, "")}</li>)}</ul></details>
                  </li>
                )}
                {estOther.map((i) => (
                  <li key={`Est:${i.message}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="rounded-md border border-slate-300 bg-slate-50 px-1.5 py-0.5 text-xs font-semibold text-slate-800" data-testid="owner-tag">Estimator</span>
                    <span className="text-slate-900">{i.message.replace(/^Estimator: /, "")}</span>
                  </li>
                ))}
              </ul>
              {est.length > 0 && <p className="mt-2 text-xs text-slate-700" data-testid="est-owner-note">The Estimator resolves these after you submit (Stage 2). They do not stop you submitting.</p>}
            </>
          )}
        {derived.stage2Reasons.length > 0 && est.length === 0 && <p className="mt-3 text-sm text-slate-700">Also open in the readiness check: {derived.stage2Reasons.join("; ")}</p>}
      </div>
    </Panel>
  );
}
