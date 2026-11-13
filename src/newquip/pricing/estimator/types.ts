import type { ForwardCover, FreightInput, FxQuote, ProjectMarkupChange, Reasoned, Stamp, SupplierCostInput } from "../model/types";

// THE ESTIMATOR'S PRICING INPUTS, as stored on a quotation draft (NQ-008B Phase 2). OPT-IN: a draft without `estimator.pricing` is priced exactly as it always was
// (the Grower POC workbook source) and its hash does not change. With it, the supplier-cost model of NQ-008B Phase 1 prices the quotation's SKUs.
//
// SERVER-OWNED, like `physicalCosts`: a client-submitted draft can never add, change or remove it (see ownership.ts); it changes only through the pricing action, which
// stamps who/when, records the reason and appends an immutable revision. It is INTERNAL: it holds supplier costs, so it is never sent to a viewer without cost visibility.

/**
 * An INDEPENDENT commercial review of one SKU's supplier cost. SERVER-OWNED: only the verification action writes it, and only a reviewer who is not the person who entered or
 * last changed that cost. `inputHash` binds it to the exact cost it covered: any later change to the supplier, currency, cost, source or freight makes it stop applying.
 */
export interface CostReview { by: string; at: string; /** What was checked against (a supplier quote or invoice reference). */ evidence: string; inputHash: string }

/**
 * One SKU's purchasing facts: who supplies it, in what currency, at what native cost, where that came from, plus its landed-cost assumptions. There is deliberately NO
 * "verified" flag a person can set: whether the cost is verified is DERIVED from `review` (see verification.ts), and `by` / `at` say who entered or last changed it.
 */
export interface SkuPricingInput extends Omit<SupplierCostInput, "verification">, Stamp {
  freight: FreightInput | null;
  review?: CostReview;
}

export interface EstimatorPricing {
  /** Literal true: the model is only ever switched ON explicitly, never inferred. */
  enabled: true;
  /** The explicitly selected pricing-rule version (see model/rule-versions.ts). */
  ruleVersionId: string;
  /** The instant the pricing is "as of" (server-set at each change); makes the evaluation deterministic. */
  pricingDate: string;
  /** Monotonic count of recorded pricing revisions (the immutable history lives in its own table). */
  revision: number;
  skus: Record<string, SkuPricingInput | undefined>;
  fxQuotes: Record<string, FxQuote | undefined>;
  /** The Estimator's forward-cover rate per currency (e.g. a 90-day contract): replaces spot, with its reason, who and when. */
  forwardCover: Record<string, ForwardCover | undefined>;
  /** A price decision for one SKU (applies wherever that SKU is priced). Needs a reason. */
  skuPriceOverrides: Record<string, (Reasoned & { unitPriceCents: number }) | undefined>;
  /** An overall change to the project markup on landed cost. Changes the item prices (it IS pricing). */
  projectMarkup: ProjectMarkupChange | null;
  /** INTERNAL ONLY: a target total for the project. Never applied to the customer quotation (its presentation is an undecided NewQuip rule); it is shown to the Estimator as the adjustment it WOULD need. */
  targetAdjustment: (Reasoned & { targetTotalCents: number }) | null;
}
