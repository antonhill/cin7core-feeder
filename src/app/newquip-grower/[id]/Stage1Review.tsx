"use client";

import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { QUOTE_TYPE_LABEL } from "@/newquip/grower/pricing-source";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { STAGE1_STEP_IDS, STAGE1_STEP_LABEL, type Stage1Derived, type Stage1StepId } from "@/newquip/quote/stage1-steps";

// Step 5 of Stage 1: a READ-ONLY summary of the live preview of the draft, the open Stage 1 reasons (each with a link back to the step that fixes it) and the way on to Stage 2.
// Nothing here edits, saves or authorises anything; "Continue to Stage 2" only navigates.
const OPTIONAL_NAMES: Record<string, string> = {
  controller: "Thomas-CL1 controller", silo_weighing: "Silo weighing", control_panel: "Control panel", emergency_windows: "Emergency windows", pad_cooling: "Pad cooling", cone_fans: "Cone fans", manure_plug: "Manure plugs",
};

export function Stage1Review({ draft, floorAreaM2, totalLabel, derived, onGoStep, onContinue }: {
  draft: QuoteDraft; floorAreaM2: number | null; totalLabel: string; derived: Stage1Derived; onGoStep: (stepId: Stage1StepId) => void; onContinue: () => void;
}) {
  const cfg = draft.config;
  const extras = Object.entries(cfg.optionalEquipment).filter(([, on]) => on).map(([k]) => OPTIONAL_NAMES[k] ?? k);
  const rows: Array<[string, string]> = [
    ["Customer", draft.customerName.trim() || "—"],
    ["Site / project", draft.siteName.trim() || "—"],
    ["Pricing basis", QUOTE_TYPE_LABEL[draft.quoteType]],
    ["Room", cfg.lengthM && cfg.widthM ? `${cfg.lengthM} m × ${cfg.widthM} m${floorAreaM2 == null ? "" : ` (${Math.round(floorAreaM2 * 1000) / 1000} m²)`} · ${cfg.rooms || 0} rooms` : "—"],
    ["Pens and pigs (per room)", `${cfg.totalPens || 0} pens (${cfg.hospitalPens || 0} hospital) · ${cfg.pigsPerRoom || 0} pigs`],
    ["Feeder variant", cfg.feederVariant === "WINDOW" ? "With window" : "Standard"],
    ["Penning pig size", cfg.penningPigSize ? cfg.penningPigSize.charAt(0) + cfg.penningPigSize.slice(1).toLowerCase() : "not chosen"],
    ["Optional ventilation items", extras.length ? extras.join(", ") : "none"],
    ["Quote total (ex VAT, live preview)", totalLabel],
  ];
  return (
    <Panel className="col-span-full">
      <PanelTitle>Review the configuration</PanelTitle>
      <p className="mt-2 max-w-3xl text-sm text-slate-700">Read-only. This is the live preview of the draft; change anything in the step named beside it. Quantities per product are entered in Stage 2.</p>
      <dl className="mt-4 grid gap-x-8 gap-y-2 text-sm md:grid-cols-2 xl:grid-cols-3" data-testid="stage1-review-summary">
        {rows.map(([k, v]) => <div key={k}><dt className="text-xs text-slate-700">{k}</dt><dd className="mt-0.5 font-medium text-slate-900">{v}</dd></div>)}
      </dl>
      <div className="mt-5" data-testid="stage1-review-issues">
        {derived.issues.length === 0
          ? <p className="text-sm font-medium text-emerald-800">Nothing is outstanding in Stage 1.</p>
          : (
            <>
              <p className="text-sm font-semibold text-slate-900">Still to fix in Stage 1</p>
              <ul className="mt-2 space-y-2">
                {derived.issues.map((i) => (
                  <li key={`${i.stepId}:${i.message}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-red-700">
                    <span>{i.message}</span>
                    <Button type="button" size="sm" variant="secondary" className="min-h-11" onClick={() => onGoStep(i.stepId)}>Go to step {STAGE1_STEP_IDS.indexOf(i.stepId) + 1}: {STAGE1_STEP_LABEL[i.stepId]}</Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        {derived.stage2Reasons.length > 0 && <p className="mt-3 text-sm text-slate-700">{derived.stage2Reasons.length} further item{derived.stage2Reasons.length === 1 ? "" : "s"} (quantities, products, prices) are resolved in Stage 2.</p>}
      </div>
      <div className="mt-5">
        <Button type="button" className="min-h-11" onClick={onContinue}>Continue to Stage 2</Button>
        <p className="mt-2 text-xs text-slate-600">Moving on never blocks and nothing is sent: Stage 2 keeps its own checks and says what is still needed before the Estimator hand-off.</p>
      </div>
    </Panel>
  );
}
