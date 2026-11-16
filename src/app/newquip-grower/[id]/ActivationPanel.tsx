"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import type { BudgetQuote } from "@/newquip/grower/quote-bridge";
import { activationPreview, money } from "@/newquip/quote/estimator-workspace";
import { applyEditor, revisionReason, type SkuEditor } from "@/newquip/quote/workspace-submission";
import { applyEstimatorPricingAction, getEstimatorPricingAction } from "../pricing-actions";
import { SkuCostForm, type SaveResult } from "./WorkspaceEditors";

// Switching supplier pricing ON, inside the new Estimator experience. It uses the EXISTING action (applyEstimatorPricingAction with no stored pricing as its base: the first revision switches the
// model on). The server needs at least one supplier cost to do it, so the activation IS the first product's cost editor: the Estimator sees, BEFORE confirming, which lines are priced from the
// reference source today and will have no price until they are costed, and what the total becomes. Nothing here prices anything; the model does.

export interface ActivationPanelProps {
  quoteId: string;
  budget: BudgetQuote;
  confirmedCents: number | null;
  canEdit: boolean;
  /** Re-reads the quotation; settles when the page shows the new figures. */
  reload: () => Promise<void> | void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Presented as THE first task of the Estimator workspace (opens at once, first-task wording) instead of an optional panel. */
  firstTask?: boolean;
  /** When no single product can take the first cost: the explicit, explained way to the older costing panel (never the silent default). */
  onUseLegacy?: () => void;
  /** While set, the first cost cannot be saved (e.g. unsaved edits elsewhere on the page would be lost when the quotation reloads). */
  pausedReason?: string | null;
}

export function ActivationPanel({ quoteId, budget, confirmedCents, canEdit, reload, onDirtyChange, firstTask = false, onUseLegacy, pausedReason = null }: ActivationPanelProps) {
  const pv = activationPreview(budget);
  const [bundle, setBundle] = useState<WorkspaceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sku, setSku] = useState<string | null>(pv.starters[0]?.sku ?? null);
  const [open, setOpen] = useState(firstTask && canEdit);
  const load = useCallback(() => { void getEstimatorPricingAction(quoteId).then((r) => { if (r.ok && r.data) { setBundle(r.data); setError(null); } else setError(r.error ?? "Supplier pricing could not be loaded."); }, () => setError("Supplier pricing could not be read.")); }, [quoteId]);
  useEffect(() => { if (open && !bundle) load(); }, [open, bundle, load]);
  const starter = pv.starters.find((s) => s.sku === sku) ?? pv.starters[0];

  async function activate(k: string, ed: SkuEditor): Promise<SaveResult> {
    const sub = applyEditor(null, k, ed, new Date().toISOString());
    if (!sub) return { ok: false, errors: ["The values are not complete, so supplier pricing was not switched on."] };
    const r = await applyEstimatorPricingAction(quoteId, sub, revisionReason(`switch on supplier pricing (first cost: ${k})`), null);
    if (!r.ok) return { ok: false, errors: r.errors?.length ? r.errors : [r.error ?? "Could not switch supplier pricing on."] };
    await reload();
    return { ok: true };
  }

  return (
    <section aria-labelledby="act-h" className="mt-4 rounded-xl border-2 border-blue-700 bg-white p-5" data-testid="activation-panel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 flex-[1_1_20rem]">
          <h2 id="act-h" className="text-lg font-bold text-slate-900">{firstTask ? "First task: start supplier costing" : <>Estimator workspace <span className="font-normal text-slate-700">· supplier pricing is off</span></>}</h2>
          <p className="mt-1 text-sm text-slate-800">{firstTask ? "This quotation is still priced from the reference price list. To price it from current supplier costs, save the first supplier cost below. That switches supplier costing on, using the existing pricing action, and is recorded as a revision. Every other product is then costed from the task list." : "Price this quotation from supplier costs, one product at a time, with the exception-first task list. Switching it on uses the existing pricing action and is recorded as a revision."}</p>
        </div>
        {canEdit && !open && <button type="button" className="inline-flex min-h-11 items-center rounded-lg bg-blue-700 px-5 text-sm font-semibold text-white hover:bg-blue-800" onClick={() => setOpen(true)} data-testid="activation-start">Switch on supplier pricing</button>}
      </div>
      {!canEdit && <p className="mt-2 text-sm text-slate-700">Only an Estimator can switch supplier pricing on.</p>}
      {open && canEdit && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="rounded-lg border border-amber-600 bg-amber-50 p-4 text-[13.5px] text-amber-950" data-testid="activation-preview">
            <p className="font-bold">What changes when supplier pricing is on</p>
            {pv.excluded.length === 0 ? <p className="mt-1">No line is priced from the reference source today, so no line leaves the total.</p> : (
              <>
                <p className="mt-1">These lines are priced from the reference source today. With supplier pricing on they have <strong>no price until a supplier cost is entered</strong>, so they leave the total:</p>
                <ul className="mt-2 flex flex-col gap-1">{pv.excluded.map((e) => <li key={e.id} className="flex flex-wrap justify-between gap-x-3" data-testid={`activation-excluded-${e.id}`}><span>{e.label} <span className="text-amber-900">· {e.why}</span></span><span className="tabular-nums">now {money(e.previous)}</span></li>)}</ul>
                <p className="mt-2 flex justify-between border-t border-amber-300 pt-1 font-semibold"><span>Excluded until costed</span><span className="tabular-nums" data-testid="activation-excluded-total">{money(pv.excludedTotal)}</span></p>
              </>
            )}
            <p className="mt-2 flex justify-between font-semibold"><span>Total today</span><span className="tabular-nums">{money(pv.currentTotal)}</span></p>
            <p className="flex justify-between font-semibold"><span>Estimated partial total once it is on, before any cost</span><span className="tabular-nums" data-testid="activation-total-after">{money(pv.totalAfter)}</span></p>
            <p className="mt-2">The estimated figure is the total today less the lines above. It is an estimate, not a pricing-model result; the model shows the real total once supplier pricing is on. It is a partial, indicative total, never a completed quotation value.{confirmedCents !== null ? <> The Rep confirmed {money(confirmedCents / 100)}. If the total moves, the Rep&apos;s confirmation is withdrawn and the quotation returns to the Rep to reconfirm.</> : null}</p>
          </div>
          {pv.starters.length === 0 ? <Alert tone="warning"><span data-testid="activation-no-starter">No single-product line can take the first supplier cost here, so supplier costing cannot be started from this screen. {onUseLegacy ? "The older costing panel can still switch it on." : "Use the older costing panel below to switch supplier pricing on."}</span>{onUseLegacy && <span className="ml-2"><button type="button" className="min-h-11 font-semibold text-blue-800 underline" onClick={onUseLegacy} data-testid="use-legacy-costing">Open the older costing panel</button></span>}</Alert> : (
            <>
              <div><label htmlFor="act-start" className="mb-1.5 block text-[13px] font-semibold">Start with the supplier cost of</label>
                <select id="act-start" className="min-h-11 w-full max-w-md rounded-lg border-[1.5px] border-slate-500 bg-white px-3 text-[15px]" value={starter?.sku ?? ""} onChange={(e) => setSku(e.target.value)}>{pv.starters.map((s) => <option key={s.sku} value={s.sku}>{s.label} · {s.sku}</option>)}</select>
                <p className="mt-1 text-[12.5px] text-slate-700">Supplier pricing switches on when this first cost is saved. Every other product is costed next, from the task list.</p></div>
              {pausedReason && <Alert tone="warning"><span data-testid="activation-paused">{pausedReason}</span></Alert>}
              {error && <Alert tone="warning"><span data-testid="activation-error">{error}</span></Alert>}
              {bundle && starter ? <SkuCostForm key={starter.sku} sku={starter.sku} label={starter.label} quantity={starter.quantity ?? 0} bundle={bundle} canEdit={canEdit && !pausedReason} save={activate} onDirty={(d) => onDirtyChange?.(d)} saveLabel="Save cost and switch on supplier pricing" testId="activation-form" /> : !error && <p className="text-sm text-slate-700" data-testid="activation-loading">Loading…</p>}
            </>
          )}
        </div>
      )}
    </section>
  );
}
