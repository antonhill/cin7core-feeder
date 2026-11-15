import type { QuoteDraft } from "../grower/draft";
import type { QuoteRole } from "./roles";

// WHO MAY CHANGE WHAT IN THE COSTING OF A NEWQUIP QUOTATION. One pure module, so every server entry point (cost-actions.ts, saveGrowerDraftAction's field-level check) asks the
// SAME questions. Owner decision (2026-11-15):
//   * Normal costing mutations need the ESTIMATOR role AND cost visibility: legacy Cin7 cost capture, supplier selection, recalculation, manual estimates (set / clear), unit-basis
//     confirmation, shared FX-rate recording, cost overrides and price resolutions.
//   * The incomplete-costing WAIVER (costBasis.incompleteAccepted) is a commercial exception: it is reserved to an authorised MANAGER (with cost visibility).
//   * A Manager keeps independent cost verification, rate attestation, approval/return and MAPPING decisions; none of those are decided here.
//   * A holder of several roles keeps what each role allows. Phase 2 pricing (canEnterPricingInputs) is unchanged and independent of this module.
// Roles are evaluated from the server-resolved session, never from the browser.

export interface CostActor { roles: ReadonlySet<QuoteRole>; canSeeCost: boolean }

/** Legacy cost capture, supplier selection, recalculation, manual estimates, unit-basis confirmation, FX rates, cost overrides, price resolutions. */
export const canMutateCosting = (a: CostActor): boolean => a.canSeeCost && a.roles.has("estimator");

/** Accepting an incomplete cost estimate for approval (a NEW waiver). A Manager only; an Estimator alone cannot grant its own exception. */
export const canAcceptIncompleteCosting = (a: CostActor): boolean => a.canSeeCost && a.roles.has("manager");

/** Confirming or changing a product mapping stays with Estimator and Manager (a Rep never may). */
export const canChangeMappings = (roles: ReadonlySet<QuoteRole>): boolean => roles.has("estimator") || roles.has("manager");

export const COSTING_DENIED = "Only an Estimator who can see costs can change the costing (supplier prices, selections, estimates, exchange rates, overrides and price resolutions).";
export const WAIVER_DENIED = "Only a Manager who can see costs can accept an incomplete cost estimate (an authorised exception).";
export const WAIVER_REASON_MIN = 10;

/** Fields of the draft that are Estimator-owned costing. Mappings are deliberately NOT here: a Manager may decide them. */
export const ESTIMATOR_COSTING_FIELDS = ["costOverrides", "priceResolutions"] as const;
export type EstimatorCostingField = (typeof ESTIMATOR_COSTING_FIELDS)[number];

const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
type Entry = { lineCostCents?: number; unitPriceExVat?: number; reason?: string };
/** Overrides / resolutions compare by what they MEAN (amount and trimmed reason); the by/at stamps are server-owned and ignored. */
const meaning = (m: unknown): string => canon(Object.fromEntries(Object.entries((m ?? {}) as Record<string, Entry | undefined>).filter(([, e]) => e).map(([k, e]) => [k, [e!.lineCostCents ?? null, e!.unitPriceExVat ?? null, (e!.reason ?? "").trim()]])));

/**
 * Which Estimator-owned costing fields does the submitted draft CHANGE relative to the stored one? Only costOverrides and priceResolutions, by amount and trimmed reason (the by/at
 * stamps are server-owned). physicalCosts and costBasis are NOT compared: the server replaces both with the stored values on every save (keepServerOwnedCosts /
 * keepServerOwnedCostBasis), so a stale client copy can neither change them nor be a reason to refuse the save.
 */
export function changedCostingFields(submitted: QuoteDraft, prior: QuoteDraft | undefined): EstimatorCostingField[] {
  const s = submitted.estimator, p = prior?.estimator;
  const out: EstimatorCostingField[] = [];
  if (meaning(s.costOverrides) !== meaning(p?.costOverrides)) out.push("costOverrides");
  if (meaning(s.priceResolutions) !== meaning(p?.priceResolutions)) out.push("priceResolutions");
  return out;
}

/** A caller with manager authority but NOT the Estimator role may not change Estimator-owned costing through a draft save. Returns the refusal text, or null. (A Rep-only caller is handled by the existing field-ownership revert.) */
export function costingSaveRefusal(roles: ReadonlySet<QuoteRole>, submitted: QuoteDraft, prior: QuoteDraft | undefined): string | null {
  if (roles.has("estimator") || !roles.has("manager")) return null;
  const changed = changedCostingFields(submitted, prior);
  return changed.length ? `Only an Estimator can change the costing (${changed.join(", ")}). Nothing was saved.` : null;
}
