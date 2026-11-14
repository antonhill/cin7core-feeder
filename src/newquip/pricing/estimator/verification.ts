import { hashOf } from "../../quote/baseline";
import { canEnterPricingInputs, type PricingRuleVersion, type Viewer } from "../model";
import { diffPricing, type PricingChange } from "./apply";
import type { CostReview, EstimatorPricing, SkuPricingInput } from "./types";

// INDEPENDENT COST VERIFICATION (NQ-008B hardening). Pure. A supplier cost is "verified" only when someone OTHER than the person who entered it has reviewed it against evidence.
// An Estimator can therefore never verify their own entry and rely on it for sign-off or approval. The rule (who may review, whether independence is required) is DATA in the
// pricing rule version; the roles named there are provisional and are not NewQuip's final personnel assignment. Everything is attributed (who, when, what evidence, which exact
// cost) and goes through the same immutable revision as any other pricing change.

/** The fields a review covers. Attribution (`by`, `at`) and the review itself are not part of the cost, so re-saving an unchanged cost keeps its review. */
export function costInputHash(s: SkuPricingInput): string {
  return hashOf({ supplierId: s.supplierId, supplierName: s.supplierName, currency: s.currency, nativeUnitCostE7: s.nativeUnitCostE7, source: s.source, freight: s.freight });
}

export type CostState =
  | "missing" // no supplier cost entered
  | "unverified" // entered, never reviewed
  | "review_outdated" // reviewed, but the cost changed afterwards
  | "self_reviewed" // reviewed by the person who entered it: not independent
  | "verified";

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

export function costStateOf(s: SkuPricingInput | undefined, rules: Pick<PricingRuleVersion, "costReview">): CostState {
  if (!s) return "missing";
  if (!s.review) return "unverified";
  if (s.review.inputHash !== costInputHash(s)) return "review_outdated";
  if (rules.costReview.requireIndependent && same(s.review.by, s.by)) return "self_reviewed";
  return "verified";
}

export const COST_STATE_TEXT: Record<CostState, string> = {
  missing: "no supplier cost has been entered",
  unverified: "the supplier cost has not been independently verified",
  review_outdated: "the supplier cost changed after it was verified, so it needs verifying again",
  self_reviewed: "the supplier cost was verified by the person who entered it; an independent reviewer is required",
  verified: "verified",
};

/** May this viewer review this SKU's cost? (role and cost visibility; independence is judged per SKU.) */
export function mayReviewCosts(v: Viewer, rules: Pick<PricingRuleVersion, "costReview">): boolean {
  return v.canSeeCost && rules.costReview.reviewerRoles.some((r) => v.roles.has(r));
}

export function mayVerifySku(v: Viewer, email: string, s: SkuPricingInput | undefined, rules: Pick<PricingRuleVersion, "costReview">): boolean {
  return !!s && mayReviewCosts(v, rules) && !(rules.costReview.requireIndependent && same(email, s.by)) && costStateOf(s, rules) !== "verified";
}

export type VerifyResult = { ok: true; next: EstimatorPricing; changes: PricingChange[] } | { ok: false; errors: string[] };

/** What the reviewer is signing: a SKU AND the exact cost (its hash) they were looking at. A cost that changed since they opened it is refused, never silently covered. */
export interface VerifyItem { sku: string; costHash: string }

/**
 * Records an independent review of the named SKUs' costs. Refuses the WHOLE request (and says why) if the reviewer lacks the role, is the person who entered any of the costs,
 * names an unknown SKU, or gives no evidence. The pricing date and every price are left exactly as they were: verification never reprices anything.
 */
export function applyCostVerification(
  prior: EstimatorPricing | undefined, items: readonly VerifyItem[], viewer: Viewer, email: string, nowIso: string, evidence: string, rules: Pick<PricingRuleVersion, "costReview">,
): VerifyResult {
  if (!prior) return { ok: false, errors: ["Supplier pricing is not switched on for this quotation."] };
  if (!canEnterPricingInputs(viewer) && !mayReviewCosts(viewer, rules)) return { ok: false, errors: ["You do not have the role to verify supplier costs."] };
  if (!mayReviewCosts(viewer, rules)) return { ok: false, errors: [`Only ${rules.costReview.reviewerRoles.join(" or ")} who can see costs may independently verify a supplier cost.`] };
  if (typeof evidence !== "string" || evidence.trim().length < 3 || evidence.length > 500) return { ok: false, errors: ["Say what the cost was verified against (for example the supplier quote reference): 3 to 500 characters."] };
  if (!Array.isArray(items) || items.length === 0 || items.length > 300) return { ok: false, errors: ["Choose at least one supplier cost to verify."] };
  const errors: string[] = [];
  const next = structuredClone(prior);
  const seen = new Set<string>();
  for (const it of items) {
    const sku = it?.sku;
    if (typeof sku !== "string" || typeof it.costHash !== "string" || !Object.prototype.hasOwnProperty.call(next.skus, sku) || !next.skus[sku]) { errors.push(`${String(sku).slice(0, 40)}: there is no supplier cost to verify.`); continue; }
    if (seen.has(sku)) continue;
    seen.add(sku);
    const s = next.skus[sku]!;
    if (it.costHash !== costInputHash(s)) { errors.push(`${sku}: the cost changed after you opened it. Open the current cost and review that.`); continue; }
    if (rules.costReview.requireIndependent && same(email, s.by)) { errors.push(`${sku}: you entered or last changed this cost, so you cannot verify it. An independent reviewer must.`); continue; }
    if (costStateOf(s, rules) === "verified") { errors.push(`${sku}: already verified.`); continue; }
    const review: CostReview = { by: email, at: nowIso, evidence: evidence.trim(), inputHash: costInputHash(s) };
    s.review = review;
  }
  if (errors.length) return { ok: false, errors };
  next.revision = prior.revision + 1; // pricingDate is deliberately NOT changed
  return { ok: true, next, changes: diffPricing(prior, next) };
}
