import type { BudgetQuote } from "../grower/quote-bridge";
import { neutralPriceText } from "../grower/pricing-source";
import { ESTIMATOR_LINE_STATUSES } from "../quote/stage1-steps";

// PRICING FEEDBACK FOR THE REP (NQ-008A). Pure. A price the Rep sees before the Manager approves is ALWAYS indicative; this says how COMPLETE that indicative price is:
//   complete    every required line is priced and nothing is outstanding;
//   provisional some lines are not priced yet (waiting for the Estimator or for the Rep) - the figure is a floor, not a quotation;
//   not_priced  nothing is priced yet. A zero is never shown as a price.
// It adds no arithmetic: the completeness is the existing BudgetQuote.state, and the reasons are the existing blockers. A viewer without cost visibility receives the
// blockers in plain price-list words (neutralPriceText), so no cost basis is named.

export type PricingCompleteness = "complete" | "provisional" | "not_priced";

export interface PricingFeedback {
  completeness: PricingCompleteness;
  /** "Indicative price: Complete" etc. - the chip text. */
  label: string;
  /** One sentence saying what the figure is and what happens next. */
  detail: string;
  /** Lines that still await the Estimator's decision or price. */
  awaitingEstimatorLines: number;
  /** What is still outstanding (at most MAX_REASONS), in words safe for the viewer. */
  reasons: string[];
  /** How many outstanding items were left out of `reasons`. */
  moreReasons: number;
}

const MAX_REASONS = 5;
export const COMPLETENESS_LABEL: Record<PricingCompleteness, string> = { complete: "Complete", provisional: "Provisional", not_priced: "Not priced yet" };

export function completenessOf(budget: BudgetQuote | null): PricingCompleteness {
  if (!budget || budget.state === "awaiting_pricing") return "not_priced";
  return budget.state === "complete" ? "complete" : "provisional";
}

export function pricingFeedback(budget: BudgetQuote | null, opts: { canViewCommercials: boolean }): PricingFeedback {
  const completeness = completenessOf(budget);
  const awaitingEstimatorLines = (budget?.lines ?? []).filter((l) => ESTIMATOR_LINE_STATUSES.has(l.status)).length;
  const all = (budget?.blockers ?? []).map((b) => (opts.canViewCommercials ? b : neutralPriceText(b)));
  const reasons = all.slice(0, MAX_REASONS);
  const detail =
    completeness === "complete"
      ? "Every required line is priced. This is still an indicative price: the Estimator reviews it and the Manager approves the formal price."
      : completeness === "provisional"
        ? `Some lines are not priced yet${awaitingEstimatorLines > 0 ? ` (${awaitingEstimatorLines} await the Estimator)` : ""}, so this figure is provisional and will change. The Estimator reviews it and the Manager approves the formal price.`
        : "Nothing is priced yet. No price is shown as zero: a line without a price is not part of the total.";
  return { completeness, label: `Indicative price: ${COMPLETENESS_LABEL[completeness]}`, detail, awaitingEstimatorLines, reasons, moreReasons: Math.max(0, all.length - reasons.length) };
}
