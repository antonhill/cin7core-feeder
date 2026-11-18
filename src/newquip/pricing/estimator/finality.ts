import type { BudgetQuote } from "../../grower/quote-bridge";
import { selectRuleVersion } from "../model";
import { pricingForSku } from "./price-source";
import { RATE_STATE_TEXT, rateDocumentationGaps, rateStateOf } from "./attestation";
import { EVIDENCE_STATE_TEXT, evidenceStateOf, skuLessManualItems } from "./manual-evidence";
import { COST_STATE_TEXT, costStateOf } from "./verification";
import type { EstimatorPricing } from "./types";

// CAN THIS PRICING BE FINAL? (NQ-008B owner decisions 2 and hardening). Pure. A price may be INDICATIVE without being final. It cannot be final while ANY supplier cost it relies on
// is unverified (or was "verified" by the person who entered it, or changed after it was reviewed), while a manually entered price conceals a supplier cost that is missing or
// unverified, or while an exchange rate it rests on has expired. The incomplete-costing exception waives NONE of this. Reasons name SKUs and currencies only, never a cost or a rate,
// and are shown to cost-entitled roles only. Rate freshness is judged against `nowIso`: an expired rate BLOCKS (it never reprices anything on its own; saving a new rate does).

export interface PricingFinality { final: boolean; reasons: string[] }

const NOT_WAIVABLE = "This cannot be waived by the incomplete-costing exception.";

/** The SKUs actually priced from the model on this quotation (single SKU lines and package components). */
export function modelPricedSkus(budget: BudgetQuote | null, p: EstimatorPricing): string[] {
  const out = new Set<string>();
  const has = (sku: string) => Object.prototype.hasOwnProperty.call(p.skus, sku) && !!p.skus[sku];
  for (const l of budget?.lines ?? []) {
    if (l.status !== "priced" || l.pricedBy !== "price_source") continue;
    if (l.components) for (const c of l.components) { if (c.status === "priced" && c.sku && has(c.sku)) out.add(c.sku); }
    else if (l.sku && has(l.sku)) out.add(l.sku);
  }
  return [...out].sort();
}

/** SKUs of lines that carry a MANUAL selling price (an Estimator resolution) instead of a supplier-priced one: their supplier cost still has to exist and be verified. */
export function manualPricedSkus(budget: BudgetQuote | null): string[] {
  const out = new Set<string>();
  for (const l of budget?.lines ?? []) {
    if (l.status !== "priced" || l.pricedBy !== "estimator_resolution") continue;
    if (l.components) for (const c of l.components) { if (c.sku && c.status !== "reference_only") out.add(c.sku); }
    else if (l.sku) out.add(l.sku);
  }
  return [...out].sort();
}

export function pricingFinality(p: EstimatorPricing | undefined, budget: BudgetQuote | null, nowIso: string = new Date().toISOString()): PricingFinality {
  if (!p?.enabled) return { final: true, reasons: [] };
  const sel = selectRuleVersion(p.ruleVersionId);
  if (!sel.ok) return { final: false, reasons: [`${sel.error} ${NOT_WAIVABLE}`] };
  const rules = sel.rules;
  const reasons: string[] = [];
  const own = (sku: string) => (Object.prototype.hasOwnProperty.call(p.skus, sku) ? p.skus[sku] : undefined);

  for (const sku of modelPricedSkus(budget, p)) {
    const st = costStateOf(own(sku), rules);
    if (st !== "verified") reasons.push(`${sku}: ${COST_STATE_TEXT[st]}, so its price is indicative only. ${NOT_WAIVABLE}`);
    const r = pricingForSku(p, sku);
    for (const i of r?.issues ?? []) if (i.code === "freight_unspecified") reasons.push(`${sku}: no freight / landed-cost assumption is recorded. ${NOT_WAIVABLE}`);
  }
  // A manually entered selling price never conceals a missing or unverified supplier cost.
  for (const sku of manualPricedSkus(budget)) {
    const st = costStateOf(own(sku), rules);
    if (st !== "verified") reasons.push(`${sku}: priced by a manual price, but ${COST_STATE_TEXT[st]}. ${NOT_WAIVABLE}`);
  }
  // Rates: judged NOW, so a quotation that waited too long cannot be signed off or approved on a rate that has since expired.
  const now = Date.parse(nowIso);
  const used = new Set(modelPricedSkus(budget, p).map((s) => own(s)?.currency).filter((c): c is string => !!c && c !== "ZAR"));
  for (const cur of [...used].sort()) {
    const f = Object.prototype.hasOwnProperty.call(p.forwardCover, cur) ? p.forwardCover[cur] : undefined;
    if (f) {
      const until = f.validUntil ? Date.parse(f.validUntil) + (f.validUntil.length <= 10 ? 86_400_000 - 1 : 0) : NaN;
      if (Number.isFinite(until) && now > until) reasons.push(`The ${cur} forward-cover rate expired on ${f.validUntil}. Record a current rate. ${NOT_WAIVABLE}`);
      // A forward-cover rate is the Estimator's own rate (no market reference): it must be documented AND independently attested. The reason names the currency only, never the rate.
      const gaps = rateDocumentationGaps(f, rules);
      if (gaps.length) reasons.push(`The ${cur} forward-cover rate is missing ${gaps.join(" and ")}, so its price is indicative only. ${NOT_WAIVABLE}`);
      else { const rs = rateStateOf(cur, f, rules); if (rs !== "attested") reasons.push(`The ${cur} forward-cover rate: ${RATE_STATE_TEXT[rs]}, so its price is indicative only. ${NOT_WAIVABLE}`); }
      continue;
    }
    const q = Object.prototype.hasOwnProperty.call(p.fxQuotes, cur) ? p.fxQuotes[cur] : undefined;
    if (q && rules.spotRateMaxAgeHours !== null && !((now - Date.parse(q.asOf)) / 3_600_000 <= rules.spotRateMaxAgeHours)) {
      reasons.push(`The ${cur} spot rate is older than ${rules.spotRateMaxAgeHours} hours. Record a current rate (nothing is repriced until you save one). ${NOT_WAIVABLE}`);
    }
  }
  // Items the Estimator prices by hand with NO SKU (M75, LED lighting, penning, any manual item) need a recorded evidence note bound to their current price. Names the item only, never a price.
  for (const item of skuLessManualItems(budget)) {
    const es = evidenceStateOf(item, p);
    if (es !== "recorded") reasons.push(`${item.label}: ${EVIDENCE_STATE_TEXT[es]}, so its price is indicative only. ${NOT_WAIVABLE}`);
  }
  return { final: reasons.length === 0, reasons: [...new Set(reasons)] };
}
