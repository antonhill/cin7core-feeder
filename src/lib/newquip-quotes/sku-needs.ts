import "server-only";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { evaluateDraft, type QuoteEvaluation } from "@/newquip/grower/evaluate";
import { skuNeedsOf, type SkuNeed } from "@/newquip/pricing/estimator";
import { evaluationContext } from "./context";

/**
 * THE Budget evaluation that decides which Cin7 products automatic pricing must request. It is the SAME evaluation (Budget, provisional packages, the same register and UAT basis) that prices the Rep's lines, so a
 * product that the Budget looks up can never be missing from the request. Used by the automatic-pricing service and pinned by sku-lookup-completeness.test.ts.
 */
export function budgetEvaluationForNeeds(draft: QuoteDraft): QuoteEvaluation { return evaluateDraft(draft, { ...evaluationContext(true), provisionalPackages: true }); }
export function budgetSkuNeeds(draft: QuoteDraft): SkuNeed[] { return skuNeedsOf(budgetEvaluationForNeeds(draft).budget); }
