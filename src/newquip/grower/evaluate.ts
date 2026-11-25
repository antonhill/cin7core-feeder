import { doorSpecificationFor } from "./door-sizes";
import { templateRevisionOf } from "./commercial";
import { calculateGrowerHouse } from "./calculate";
import { buildBudgetQuote, type BudgetQuote } from "./quote-bridge";
import { assessReadiness, type Readiness } from "./readiness";
import { POC_TAX } from "./final-feedback";
import type { PriceSource } from "./pricing-source";
import type { QuoteDraft } from "./draft";
import { createEstimatorPriceSource } from "../pricing/estimator/price-source";
import type { GrowerCalculationResult } from "./types";
import { ACTIVE_BUDGET_BASIS } from "./budget-basis-register";
import type { BudgetBasisEntry } from "./budget-basis";

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
  /** BUDGET evaluation only: price evidence-complete packages that still await the Estimator provisionally (see provisionalPackageBasis). Default off: every other caller is unchanged. */
  provisionalPackages?: boolean;
  /** BUDGET evaluation only (with provisionalPackages): the approved default products / rates. Default: the active register (empty until NewQuip approves entries). Tests inject their own. */
  budgetBasis?: readonly BudgetBasisEntry[];
  /** ISO date the register is checked against (default today). */
  budgetAsOf?: string;
}

export function evaluateDraft(draft: QuoteDraft, ctx: EvaluationContext): QuoteEvaluation {
  const calc = calculateGrowerHouse(draft.config);
  const budget = calc.valid
    ? buildBudgetQuote(calc.lines, {
        // OPT-IN (NQ-008B Phase 2): only a draft that carries Estimator pricing is priced by the supplier-cost model; every other draft uses the POC source exactly as before.
        priceSource: draft.estimator.pricing?.enabled ? createEstimatorPriceSource(draft.estimator.pricing) : ctx.priceSource,
        quoteType: draft.quoteType,
        taxRatePct: POC_TAX.ratePct,
        taxInclusive: POC_TAX.inclusive,
        confirmedMappings: draft.estimator.confirmedMappings,
        confirmedPackages: new Set(draft.estimator.confirmedPackages),
        feederVariant: draft.config.feederVariant,
        doorSpecification: doorSpecificationFor(draft.config.doorSize),
        templateRevision: templateRevisionOf(draft),
        penningPigSize: draft.config.penningPigSize ?? null,
        coolingSystemLengthM: draft.config.coolingSystemLengthM ?? null,
        ...(ctx.provisionalPackages === true ? { panelSelection: { controller: Boolean(draft.config.optionalEquipment?.controller), silo_weighing: Boolean(draft.config.optionalEquipment?.silo_weighing) } } : {}),
        estimatorCharges: draft.estimator.charges,
        estimatorUnitPrices: draft.estimator.unitPrices,
        priceResolutions: draft.estimator.priceResolutions,
        withholdCost: ctx.withholdCost,
        ...(ctx.provisionalPackages === true ? { provisionalPackages: true, budgetBasis: ctx.budgetBasis ?? ACTIVE_BUDGET_BASIS, ...(ctx.budgetAsOf ? { budgetAsOf: ctx.budgetAsOf } : {}), budgetMarkupBps: draft.estimator.pricing?.projectMarkup?.markupBps ?? null } : {}),
      })
    : null;
  return { calc, budget, readiness: assessReadiness(draft, calc, budget) };
}
