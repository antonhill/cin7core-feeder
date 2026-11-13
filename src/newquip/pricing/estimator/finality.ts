import type { BudgetQuote } from "../../grower/quote-bridge";
import { pricingForSku } from "./price-source";
import type { EstimatorPricing } from "./types";

// CAN THIS PRICING BE FINAL? (NQ-008B Phase 2, owner decision 2). Unverified supplier costs may support a clearly labelled INDICATIVE estimate only: they must not silently
// qualify a quotation for Estimator sign-off or final Manager approval, and the existing "accept incomplete costing" exception does NOT waive this (no exception is defined).
// Pure. Reasons name SKUs only, never a cost or rate, and are shown to cost-entitled roles only.

export interface PricingFinality { final: boolean; reasons: string[] }

const NOT_WAIVABLE = "This cannot be waived by the incomplete-costing exception.";

/** The SKUs actually priced from the model on this quotation (single SKU lines and package components). */
export function modelPricedSkus(budget: BudgetQuote | null, p: EstimatorPricing): string[] {
  const out = new Set<string>();
  for (const l of budget?.lines ?? []) {
    if (l.status !== "priced" || l.pricedBy !== "price_source") continue;
    if (l.components) for (const c of l.components) { if (c.status === "priced" && c.sku && p.skus[c.sku]) out.add(c.sku); }
    else if (l.sku && p.skus[l.sku]) out.add(l.sku);
  }
  return [...out].sort();
}

export function pricingFinality(p: EstimatorPricing | undefined, budget: BudgetQuote | null): PricingFinality {
  if (!p?.enabled) return { final: true, reasons: [] };
  const reasons: string[] = [];
  for (const sku of modelPricedSkus(budget, p)) {
    const input = p.skus[sku]!;
    if (input.verification !== "verified") reasons.push(`${sku}: the supplier cost is not verified, so its price is indicative only. ${NOT_WAIVABLE}`);
    const r = pricingForSku(p, sku);
    for (const i of r?.issues ?? []) {
      if (i.code === "stale_rate") reasons.push(`${sku}: the exchange rate is out of date. ${NOT_WAIVABLE}`);
      if (i.code === "freight_unspecified") reasons.push(`${sku}: no freight / landed-cost assumption is recorded. ${NOT_WAIVABLE}`);
    }
  }
  return { final: reasons.length === 0, reasons: [...new Set(reasons)] };
}
