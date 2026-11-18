import { TEMPLATE_REVISION_CURRENT, TEMPLATE_REVISION_LEGACY, templateRevisionOf, type TemplateRevision } from "../grower/commercial";
import type { QuoteDraft } from "../grower/draft";
import { evaluateDraft, type EvaluationContext } from "../grower/evaluate";
import type { BridgeComponent } from "../grower/quote-bridge";

// ADOPTING THE CURRENT TEMPLATE REVISION ON AN EXISTING QUOTATION. Pure. An existing quotation keeps the template it was created under (see commercial.ts); moving it is a deliberate commercial
// decision, so this module only COMPUTES what would change (old v new components, quantities and selling values; which approvals would be invalidated) and BUILDS the adopted draft. The
// server action decides who may do it, binds the Estimator's acknowledgement to these exact figures, and applies it through the normal revision and Rep-reconfirmation controls.

export type AdoptionState = "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL" | string;
export interface AdoptionLine { status: string; sellingExVat: number | null; reason: string; components: Array<{ sku: string | null; description: string; quantity: number | null; qtyPerUnit: number | null; status: string }> }
export interface AdoptionImpact {
  from: TemplateRevision; to: TemplateRevision;
  eligible: boolean; refusal: string | null;
  /** The LED line as it is today, and as it would be after adoption (a) with the new package confirmed in the same action and (b) left unconfirmed. */
  led: { before: AdoptionLine | null; afterConfirmed: AdoptionLine | null; afterUnconfirmed: AdoptionLine | null };
  /** Commercial total ex VAT (priced lines only), in rand; `complete` says whether every line is priced. */
  totals: { before: { exVat: number; complete: boolean }; afterConfirmed: { exVat: number; complete: boolean }; afterUnconfirmed: { exVat: number; complete: boolean } };
  /** Differences that do not change a price but are part of the revision (shown, never hidden). */
  otherDifferences: string[];
  /** SKUs the new LED package brings in that carry no supplier cost on this quotation yet (relevant only when supplier pricing is on). */
  newSkus: string[];
  effects: { confirmationWithdrawn: boolean; signoffCleared: boolean; returnedToRep: boolean };
}

const ledOf = (d: QuoteDraft, ctx: EvaluationContext): AdoptionLine | null => {
  const b = evaluateDraft(d, ctx).budget;
  const l = b?.lines.find((x) => x.itemKey === "led_light");
  if (!l || l.status === "not_selected") return null;
  return { status: l.status, sellingExVat: l.revenueExTax ?? null, reason: l.reason, components: (l.components ?? []).map((c: BridgeComponent) => ({ sku: c.sku, description: c.description, quantity: c.quantity, qtyPerUnit: c.qtyPerUnit, status: c.status })) };
};
const totalOf = (d: QuoteDraft, ctx: EvaluationContext) => { const b = evaluateDraft(d, ctx).budget; return { exVat: b ? Math.round(b.totals.subtotalExTax * 100) / 100 : 0, complete: !!b && !b.incomplete }; };

/** The draft AFTER adoption. The new LED package is NEVER confirmed implicitly: without `confirmNewLedPackage` the previous LED confirmation is removed, so the Estimator must confirm the new composition. */
export function adoptedDraft(draft: QuoteDraft, opts: { confirmNewLedPackage: boolean }): QuoteDraft {
  const next = structuredClone(draft);
  next.estimator.templateRevision = TEMPLATE_REVISION_CURRENT;
  const rest = next.estimator.confirmedPackages.filter((k) => k !== "led_light");
  next.estimator.confirmedPackages = opts.confirmNewLedPackage ? [...rest, "led_light"] : rest;
  return next;
}

export function adoptionImpact(draft: QuoteDraft, state: { state: AdoptionState; customerConfirmed: boolean; signedOff: boolean }, ctx: EvaluationContext): AdoptionImpact {
  const from = templateRevisionOf(draft);
  const refusal = from === TEMPLATE_REVISION_CURRENT ? "This quotation already uses the current template revision."
    : state.state === "MANAGER_APPROVED_FINAL" ? "An approved quotation is sealed: its scope and prices never change."
    : state.state !== "REP_DRAFT" && state.state !== "ESTIMATOR_REVIEW" ? "The quotation is not in a state where its scope can be changed."
    : null;
  const confirmed = adoptedDraft(draft, { confirmNewLedPackage: true });
  const unconfirmed = adoptedDraft(draft, { confirmNewLedPackage: false });
  const before = ledOf(draft, ctx), afterC = ledOf(confirmed, ctx);
  const have = new Set((draft.estimator.pricing?.skus ? Object.keys(draft.estimator.pricing.skus) : []));
  const newSkus = draft.estimator.pricing?.enabled ? (afterC?.components ?? []).flatMap((c) => (c.sku && !have.has(c.sku) ? [c.sku] : [])) : [];
  const tb = totalOf(draft, ctx);
  return {
    from, to: TEMPLATE_REVISION_CURRENT, eligible: refusal === null, refusal,
    led: { before, afterConfirmed: afterC, afterUnconfirmed: ledOf(unconfirmed, ctx) },
    totals: { before: tb, afterConfirmed: totalOf(confirmed, ctx), afterUnconfirmed: totalOf(unconfirmed, ctx) },
    otherDifferences: [
      "M75 reference package: support post KNQ050-900 replaces the NQ2601 candidate; the drop tube stays an unresolved choice (NQ.TUBE.63 or NQ.TUBE.75). The M75 system price is still the Estimator's.",
      "PVC door choices: NQ3444 is offered first and NQ2112, NQ2113 and NQ2114 are no longer offered for a new selection. A door already chosen is kept as it is.",
      "Penning, alternatives (PNQ002, SYSH-2750-4) and the NQ1984 exclusion add scope information or choices only: they change no price on this quotation.",
    ],
    newSkus,
    effects: { confirmationWithdrawn: state.customerConfirmed, signoffCleared: state.signedOff || state.customerConfirmed, returnedToRep: state.customerConfirmed && state.state === "ESTIMATOR_REVIEW" },
  };
}
export { TEMPLATE_REVISION_LEGACY };
