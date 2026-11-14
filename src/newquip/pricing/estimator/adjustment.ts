import { figures } from "../model";
import type { MarginFigures } from "@/lib/projects/margin-figures";
import type { EstimatorPricing } from "./types";

// THE INTERNAL TARGET-PRICE ADJUSTMENT (NQ-008B Phase 2, owner decision 3). Pure. The customer-facing presentation of a project-level adjustment is not decided, so the
// adjustment is NEVER applied to the quotation total that the Rep confirms, the snapshot records or the Manager approves. It is shown to the Estimator as what it WOULD be:
// the difference between the target and the current quotation total, and the markup / gross margin at the target. Nothing here changes a price.

export interface InternalAdjustmentView {
  targetTotalCents: number;
  currentTotalCents: number;
  /** target - current: negative = a reduction. Not applied to the customer quotation. */
  wouldAdjustByCents: number;
  /** Margin and markup at the target price, against the quotation's current known cost; null while the cost is not complete. */
  atTarget: MarginFigures | null;
  reason: string;
  by: string;
  at: string;
  applied: false;
}

export function internalAdjustmentView(p: EstimatorPricing | undefined, current: { totalCents: number | null; costCents: number | null; costComplete: boolean }): InternalAdjustmentView | null {
  const t = p?.targetAdjustment;
  if (!t || current.totalCents === null) return null; // no current total (an unpriced line): a target is not compared with a partial total
  return {
    targetTotalCents: t.targetTotalCents, currentTotalCents: current.totalCents, wouldAdjustByCents: t.targetTotalCents - current.totalCents,
    atTarget: current.costComplete && current.costCents !== null ? figures(t.targetTotalCents, current.costCents) : null,
    reason: t.reason, by: t.by, at: t.at, applied: false,
  };
}
