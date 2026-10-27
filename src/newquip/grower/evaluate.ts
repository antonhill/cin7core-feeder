import { calculateGrowerHouse } from "./calculate";
import { buildBudgetQuote, type BudgetQuote } from "./quote-bridge";
import { assessReadiness, type Readiness } from "./readiness";
import { POC_TAX } from "./final-feedback";
import type { PriceSource } from "./pricing-source";
import type { QuoteDraft } from "./draft";
import type { GrowerCalculationResult } from "./types";

// ONE function turns an editable draft into everything the quote screens show: engineering result, priced budget, readiness.
// Pure and deterministic — the server runs it for display AND again at approval, so a client can never supply its own total.

export interface QuoteEvaluation {
  calc: GrowerCalculationResult;
  /** Null while the engineering inputs are invalid (nothing can be priced). */
  budget: BudgetQuote | null;
  readiness: Readiness;
}

export interface EvaluationContext {
  priceSource: PriceSource;
  /** True for viewers who may not see cost / margin. */
  withholdCost: boolean;
}

export function evaluateDraft(draft: QuoteDraft, ctx: EvaluationContext): QuoteEvaluation {
  const calc = calculateGrowerHouse(draft.config);
  const budget = calc.valid
    ? buildBudgetQuote(calc.lines, {
        priceSource: ctx.priceSource,
        quoteType: draft.quoteType,
        taxRatePct: POC_TAX.ratePct,
        taxInclusive: POC_TAX.inclusive,
        confirmedMappings: draft.estimator.confirmedMappings,
        confirmedPackages: new Set(draft.estimator.confirmedPackages),
        feederVariant: draft.config.feederVariant,
        penningPigSize: draft.config.penningPigSize ?? null,
        estimatorCharges: draft.estimator.charges,
        estimatorUnitPrices: draft.estimator.unitPrices,
        priceResolutions: draft.estimator.priceResolutions,
        withholdCost: ctx.withholdCost,
      })
    : null;
  return { calc, budget, readiness: assessReadiness(draft, calc, budget) };
}
