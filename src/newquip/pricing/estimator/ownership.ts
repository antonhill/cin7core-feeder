import type { QuoteDraft } from "../../grower/draft";

// The pricing inputs are SERVER-OWNED and INTERNAL (NQ-008B Phase 2): the draft a client submits never decides them, and a viewer without cost visibility never receives them.

/** Whatever pricing a submitted draft carries is discarded; the stored (prior) pricing is kept as it is. Only the pricing action changes it. */
export function keepServerOwnedPricing<D extends QuoteDraft>(draft: D, prior: QuoteDraft | undefined): D {
  const next = structuredClone(draft);
  const before = prior?.estimator.pricing;
  if (before !== undefined) next.estimator.pricing = structuredClone(before); else delete next.estimator.pricing;
  return next;
}
