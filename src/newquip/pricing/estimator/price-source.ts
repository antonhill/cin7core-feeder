import type { PriceResult, PriceSource, PriceSourceDescriptor, QuoteType } from "../../grower/pricing-source";
import { hashOf } from "../../quote/baseline";
import { calculatePricing, PricingInputError, selectRuleVersion, type PricingResult, type PricingScenario } from "../model";
import type { EstimatorPricing } from "./types";

// THE ESTIMATOR PRICING MODEL AS A PRICE SOURCE (NQ-008B Phase 2). The quote engine already asks a `PriceSource` for one SKU at a time and never reads a source directly, so
// plugging the model in here changes NO engine, bridge, snapshot or approval code: every total, indicative snapshot, comparison, sign-off and baseline just follows the prices
// this source returns. A SKU with no supplier cost entered is NOT priced (never zero, never silently taken from the POC workbook): it blocks readiness until the Estimator enters it.

const EPOCH_PRICING = "estimator_supplier_pricing" as const;

/** The scenario for ONE SKU (quantity 1): its supplier cost, the rates, the SKU price override and the project markup. */
export function scenarioForSku(p: EstimatorPricing, sku: string): PricingScenario | null {
  const s = p.skus[sku];
  if (!s) return null;
  const { freight, by: _by, at: _at, ...cost } = s; void _by; void _at;
  const ov = p.skuPriceOverrides[sku];
  return {
    pricingDate: p.pricingDate,
    fxQuotes: p.fxQuotes,
    forwardCover: p.forwardCover,
    lines: [{ key: sku, label: sku, sku, quantity: 1, cost, freight }],
    itemOverrides: ov ? { [sku]: { price: ov } } : {},
    projectMarkup: p.projectMarkup,
    projectAdjustment: null,
  };
}

/** The model's full result for one SKU (null when there is no input or the input is invalid). Internal: carries cost. */
export function pricingForSku(p: EstimatorPricing, sku: string): PricingResult | null {
  const rules = selectRuleVersion(p.ruleVersionId);
  const scenario = scenarioForSku(p, sku);
  if (!rules.ok || !scenario) return null;
  try { return calculatePricing(scenario, rules.rules); } catch (e) { if (e instanceof PricingInputError) return null; throw e; }
}

export function describePricing(p: EstimatorPricing): PriceSourceDescriptor {
  return {
    id: EPOCH_PRICING,
    label: `Estimator supplier pricing (rules ${p.ruleVersionId})`,
    basis: "Supplier cost x exchange rate x freight, plus the project markup.",
    provenance: `Estimator pricing revision ${p.revision} · rules ${p.ruleVersionId} · inputs ${hashOf(p).slice(0, 12)}`,
    notice: "Estimator-entered supplier pricing. A price resting on an unverified cost is indicative only.",
  };
}

export function createEstimatorPriceSource(p: EstimatorPricing): PriceSource {
  return {
    descriptor: describePricing(p),
    has: (sku) => Boolean(p.skus[sku]),
    priceFor(sku: string, quoteType: QuoteType): PriceResult {
      if (quoteType !== "project") return { status: "not_in_source", reason: `${sku} cannot be priced yet: supplier pricing applies to project quotations only.` };
      // Deliberately neutral wording: this text can reach a viewer who may not see cost.
      const none: PriceResult = { status: "not_in_source", reason: `${sku} has no price yet (awaiting the Estimator).` };
      const r = pricingForSku(p, sku);
      const l = r?.lines[0];
      if (!l || l.status !== "priced" || l.unitPriceCents === null || l.unitLandedCostCents === null) return none;
      if (l.unitPriceCents <= 0 || l.unitLandedCostCents <= 0) {
        return { status: "supplier_quote_required", reason: `N/A - supplier quote required: the price for ${sku} is zero. It is never quoted at R0.` };
      }
      return { status: "priced", unitPriceExVat: l.unitPriceCents / 100, landedCostExVat: l.unitLandedCostCents / 100 };
    },
  };
}
