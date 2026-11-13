import { hashOf } from "../../quote/baseline";
import { canEnterPricingInputs, type PricingRuleVersion, type Viewer } from "../model";
import { diffPricing, type PricingChange } from "./apply";
import type { EstimatorPricing, RateReview, StoredForwardCover } from "./types";

// INDEPENDENT FORWARD-COVER RATE ATTESTATION (NQ-008B P2-E). Pure. A forward-cover rate is the Estimator's OWN rate: it replaces spot, with no market reference, so it is only
// trustworthy once someone OTHER than the person who entered it has checked its contract reference, validity dates and evidence. A person can never attest their own rate. Who may
// attest and whether independence is required is DATA in the pricing rule version (`rateReview`); the roles named there are provisional, not NewQuip's final personnel assignment.
// Spot rates are NOT attested: they keep the freshness limit. Nothing here reprices anything.

/** The fields an attestation covers. Attribution (`by`, `at`) and the review itself are not part of the rate, so re-saving an unchanged rate keeps its attestation. */
export function rateInputHash(currency: string, f: StoredForwardCover): string {
  return hashOf({ currency, rateMicro: f.rateMicro, coverDays: f.coverDays, reference: f.reference ?? null, validFrom: f.validFrom ?? null, validUntil: f.validUntil ?? null, reason: (f.reason ?? "").trim() });
}

export type RateState =
  | "missing" // no forward-cover rate for this currency
  | "undocumented" // no contract reference, or no validity dates where the rule requires them
  | "unattested" // documented, never attested
  | "attestation_outdated" // attested, but the rate (or its contract, dates, reason) changed afterwards
  | "self_attested" // attested by the person who entered it: not independent
  | "attested";

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();
type RateRules = Pick<PricingRuleVersion, "rateReview" | "forwardCoverNeedsValidity">;

/** What is missing from a forward-cover rate before anyone could attest it (plain language, no rate). */
export function rateDocumentationGaps(f: StoredForwardCover, rules: Pick<PricingRuleVersion, "forwardCoverNeedsValidity">): string[] {
  const gaps: string[] = [];
  if (!f.reference || f.reference.trim().length < 3) gaps.push("the contract reference");
  if (rules.forwardCoverNeedsValidity && (!f.validFrom || !f.validUntil)) gaps.push("the validity dates");
  return gaps;
}

export function rateStateOf(currency: string, f: StoredForwardCover | undefined, rules: RateRules): RateState {
  if (!f) return "missing";
  if (rateDocumentationGaps(f, rules).length > 0) return "undocumented";
  if (!f.review) return "unattested";
  if (f.review.inputHash !== rateInputHash(currency, f)) return "attestation_outdated";
  if (rules.rateReview.requireIndependent && same(f.review.by, f.by)) return "self_attested";
  return "attested";
}

export const RATE_STATE_TEXT: Record<RateState, string> = {
  missing: "there is no forward-cover rate",
  undocumented: "the forward-cover rate is missing its contract reference or validity dates",
  unattested: "the forward-cover rate has not been independently attested",
  attestation_outdated: "the forward-cover rate changed after it was attested, so it needs attesting again",
  self_attested: "the forward-cover rate was attested by the person who entered it; an independent reviewer is required",
  attested: "attested",
};

/** May this viewer attest forward-cover rates at all? (role and cost visibility; independence is judged per rate.) */
export function mayAttestRates(v: Viewer, rules: Pick<PricingRuleVersion, "rateReview">): boolean {
  return v.canSeeCost && rules.rateReview.reviewerRoles.some((r) => v.roles.has(r));
}

export function mayAttestRate(v: Viewer, email: string, currency: string, f: StoredForwardCover | undefined, rules: RateRules): boolean {
  if (!f || !mayAttestRates(v, rules) || (rules.rateReview.requireIndependent && same(email, f.by))) return false;
  const st = rateStateOf(currency, f, rules);
  return st === "unattested" || st === "attestation_outdated" || st === "self_attested";
}

export type AttestResult = { ok: true; next: EstimatorPricing; changes: PricingChange[] } | { ok: false; errors: string[] };

/** What the reviewer is signing: a currency AND the exact rate (its hash) they were looking at. A rate that changed since they opened it is refused, never silently covered. */
export interface AttestItem { currency: string; rateHash: string }

/**
 * Records an independent attestation of the named currencies' forward-cover rates. Refuses the WHOLE request (and says why) if the reviewer lacks the role, is the person who entered
 * any of the rates, names a currency with no forward-cover rate, a stale hash, a rate that lacks its contract reference or validity dates, or gives no evidence. The pricing date and
 * every price are left exactly as they were.
 */
export function applyRateAttestation(
  prior: EstimatorPricing | undefined, items: readonly AttestItem[], viewer: Viewer, email: string, nowIso: string, evidence: string, rules: RateRules,
): AttestResult {
  if (!prior) return { ok: false, errors: ["Supplier pricing is not switched on for this quotation."] };
  if (!canEnterPricingInputs(viewer) && !mayAttestRates(viewer, rules)) return { ok: false, errors: ["You do not have the role to attest forward-cover rates."] };
  if (!mayAttestRates(viewer, rules)) return { ok: false, errors: [`Only ${rules.rateReview.reviewerRoles.join(" or ")} who can see costs may independently attest a forward-cover rate.`] };
  if (typeof evidence !== "string" || evidence.trim().length < 3 || evidence.length > 500) return { ok: false, errors: ["Say what the rate was attested against (for example the forward-exchange contract or the bank confirmation): 3 to 500 characters."] };
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) return { ok: false, errors: ["Choose at least one forward-cover rate to attest."] };
  const errors: string[] = [];
  const next = structuredClone(prior);
  const seen = new Set<string>();
  for (const it of items) {
    const cur = it?.currency;
    if (typeof cur !== "string" || typeof it.rateHash !== "string" || !/^[A-Z]{3}$/.test(cur) || !Object.prototype.hasOwnProperty.call(next.forwardCover, cur) || !next.forwardCover[cur]) { errors.push(`${String(cur).slice(0, 12)}: there is no forward-cover rate to attest.`); continue; }
    if (seen.has(cur)) continue;
    seen.add(cur);
    const f = next.forwardCover[cur]!;
    const gaps = rateDocumentationGaps(f, rules);
    if (gaps.length) { errors.push(`${cur}: record ${gaps.join(" and ")} before the rate can be attested.`); continue; }
    if (it.rateHash !== rateInputHash(cur, f)) { errors.push(`${cur}: the rate changed after you opened it. Open the current rate and review that.`); continue; }
    if (rules.rateReview.requireIndependent && same(email, f.by)) { errors.push(`${cur}: you entered or last changed this rate, so you cannot attest it. An independent reviewer must.`); continue; }
    if (rateStateOf(cur, f, rules) === "attested") { errors.push(`${cur}: already attested.`); continue; }
    const review: RateReview = { by: email, at: nowIso, evidence: evidence.trim(), inputHash: rateInputHash(cur, f) };
    f.review = review;
  }
  if (errors.length) return { ok: false, errors };
  next.revision = prior.revision + 1; // pricingDate is deliberately NOT changed
  return { ok: true, next, changes: diffPricing(prior, next) };
}
