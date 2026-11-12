import { micro } from "./money";
import type { PricingLineInput, PricingRuleVersion, PricingScenario } from "./types";

// DEVELOPMENT FIXTURES (NQ-008B Phase 1). Invented figures that exercise the model; they are not NewQuip prices, costs, rates or rules. The shapes are exactly what a completed
// supplier workbook has to be converted into (supplier, currency, native cost, source, freight), so importing it later is a mapping exercise, not a redesign.

/** DEVELOPMENT FIXTURE ONLY. Placeholder figures so the model can be exercised; NOT NewQuip rules. Deliberately not in the rule-version registry and not exported from the model's index. */
export const FIXTURE_DRAFT_RULE_VERSION: PricingRuleVersion = {
  id: "fixture-draft-v0",
  label: "Development fixture (not a NewQuip rule)",
  status: "draft",
  markupBps: 2000,
  unverifiedCost: "flag",
  freightUnspecified: "flag",
  maxRateAgeDays: 7,
};

export const FIXTURE_PRICING_DATE = "2026-11-12T08:00:00.000Z";
export const FIXTURE_ACTOR = "estimator@example.test";
const SRC = "Fixture supplier sheet";

export const eurLine = (qty = 10): PricingLineInput => ({
  key: "feeder", label: "Feeder trough", sku: "FX-EUR-1", quantity: qty,
  cost: { supplierId: "sup-eu", supplierName: "Euro Supplier BV", currency: "EUR", nativeUnitCostMicro: micro("100"), verification: "verified", source: SRC },
  freight: { factorMicro: micro("1.15"), source: SRC },
});
export const usdLine = (qty = 40): PricingLineInput => ({
  key: "drinker", label: "Drinker unit", sku: "FX-USD-1", quantity: qty,
  cost: { supplierId: "sup-us", supplierName: "US Supplier Inc", currency: "USD", nativeUnitCostMicro: micro("50"), verification: "verified", source: SRC },
  freight: { factorMicro: micro("1.10"), source: SRC },
});
export const zarLine = (qty = 20): PricingLineInput => ({
  key: "fixings", label: "Fixing kit", sku: "FX-ZAR-1", quantity: qty,
  cost: { supplierId: "sup-za", supplierName: "Local Supplier (Pty) Ltd", currency: "ZAR", nativeUnitCostMicro: micro("250"), verification: "verified", source: SRC },
  freight: { factorMicro: micro("1"), source: SRC },
});
export const missingCostLine = (): PricingLineInput => ({ key: "controller", label: "Controller", sku: "FX-CTL-1", quantity: 1, cost: null, freight: null });

/** A ZAR customer quotation made of EUR, USD and ZAR supplier products. */
export function baseScenario(over: Partial<PricingScenario> = {}): PricingScenario {
  return {
    pricingDate: FIXTURE_PRICING_DATE,
    fxQuotes: {
      EUR: { rateMicro: micro("20"), source: "Fixture spot", asOf: "2026-11-11T08:00:00.000Z" },
      USD: { rateMicro: micro("18.5"), source: "Fixture spot", asOf: "2026-11-11T08:00:00.000Z" },
    },
    forwardCover: {},
    lines: [eurLine(), usdLine(), zarLine()],
    itemOverrides: {},
    projectMarkup: null,
    projectAdjustment: null,
    ...over,
  };
}
