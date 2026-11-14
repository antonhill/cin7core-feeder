import { selectRuleVersion, type PricingRuleVersion } from "../model";
import { rateDocumentationGaps, rateStateOf } from "./attestation";
import { costStateOf } from "./verification";
import type { EstimatorPricing } from "./types";

// WHICH LEGACY "NO SUPPLIER COST SELECTED" REASONS THE PHASE 2 SUPPLIER PRICING SATISFIES (NQ-008B follow-up). Pure.
//
// The legacy costing check (readiness-concepts.ts `estimatorCostingComplete`, and the baseline freeze) lists every physical SKU of the CURRENT scope that has no captured supplier cost. A quotation
// that has switched on Estimator supplier pricing records its supplier costs in `estimator.pricing` instead, with independent verification, so without this a normal, fully verified Phase 2
// quotation could never pass that check unless a costing waiver was recorded.
//
// A legacy-missing SKU counts as covered ONLY when the CURRENT pricing holds, for exactly that SKU, a cost that is complete and independently verified, with its landed-cost assumption and a
// usable exchange rate:
//   * supplier pricing is enabled and its rule version can be used;
//   * the SKU has an entry with a positive whole-unit cost, a three-letter currency and a recorded source;
//   * the cost is independently VERIFIED (never unverified, outdated after a change, or verified by the person who entered it);
//   * a freight / landed-cost assumption is recorded (never assumed);
//   * the exchange rate is usable NOW: ZAR needs none; a forward-cover rate must be documented, inside its validity and independently attested (and, as everywhere, it is then the only rate
//     considered: there is never a fall-back to spot); otherwise a spot rate must exist and be inside its freshness limit.
// Anything else (no entry, an entry for another SKU, an unverified or changed cost, a missing rate) is NOT covered, so the reason stays. The function never covers a SKU that is not in the list it is
// given (which the caller derives from the current scope and quantities), it grants no exception and it changes no stored value. Every other Phase 2 gate (finality.ts) is unaffected.

const own = <T>(o: Record<string, T>, k: string): T | undefined => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

function rateUsable(p: EstimatorPricing, currency: string, rules: PricingRuleVersion, nowMs: number): boolean {
  if (currency === "ZAR") return true;
  const f = own(p.forwardCover, currency);
  if (f) {
    if (rateDocumentationGaps(f, rules).length > 0) return false;
    if (rateStateOf(currency, f, rules) !== "attested") return false;
    if (!Number.isSafeInteger(f.rateMicro) || f.rateMicro <= 0) return false;
    const from = f.validFrom ? Date.parse(f.validFrom) : NaN;
    const until = f.validUntil ? Date.parse(f.validUntil) + (f.validUntil.length <= 10 ? 86_400_000 - 1 : 0) : NaN;
    if (rules.forwardCoverNeedsValidity && (!Number.isFinite(from) || !Number.isFinite(until))) return false;
    if (Number.isFinite(from) && nowMs < from) return false;
    if (Number.isFinite(until) && nowMs > until) return false;
    return true;
  }
  const q = own(p.fxQuotes, currency);
  if (!q || !Number.isSafeInteger(q.rateMicro) || q.rateMicro <= 0) return false;
  const asOf = Date.parse(q.asOf);
  if (!Number.isFinite(asOf)) return false;
  return rules.spotRateMaxAgeHours === null || (nowMs - asOf) / 3_600_000 <= rules.spotRateMaxAgeHours;
}

/** The subset of `skus` (the legacy-missing SKUs of the current scope) whose cost is satisfied by the CURRENT, independently verified Phase 2 pricing. Empty when supplier pricing is off. */
export function legacyCostCoveredBy(p: EstimatorPricing | undefined, skus: readonly string[], nowIso: string): ReadonlySet<string> {
  const covered = new Set<string>();
  if (!p?.enabled) return covered;
  const sel = selectRuleVersion(p.ruleVersionId);
  if (!sel.ok) return covered;
  const rules = sel.rules;
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(nowMs)) return covered;
  for (const sku of skus) {
    const s = own(p.skus, sku);
    if (!s) continue;
    if (!Number.isSafeInteger(s.nativeUnitCostE7) || s.nativeUnitCostE7 <= 0) continue;
    if (!/^[A-Z]{3}$/.test(s.currency) || !s.source || !s.source.trim()) continue;
    if (costStateOf(s, rules) !== "verified") continue;
    if (!s.freight || !Number.isSafeInteger(s.freight.factorMicro) || s.freight.factorMicro <= 0) continue;
    if (!rateUsable(p, s.currency, rules, nowMs)) continue;
    covered.add(sku);
  }
  return covered;
}

/** The function the legacy checks accept: "which of these SKUs does the current Phase 2 pricing cover?". */
export type LegacyCostCoverage = (missingSkus: readonly string[]) => ReadonlySet<string>;
export const legacyCostCoverageFor = (p: EstimatorPricing | undefined, nowIso: string): LegacyCostCoverage => (skus) => legacyCostCoveredBy(p, skus, nowIso);
