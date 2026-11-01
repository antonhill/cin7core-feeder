// Client-side state of the approval review page after a decision. The decision itself is atomic in the database (approval_decide_staged);
// this only makes the page agree with it IMMEDIATELY, so the decision controls can never stay on screen if the follow-up reload is slow or fails.

interface DecidedLike { status: string }
interface CanLike { decide: boolean; withdraw: boolean; reassign: boolean; needsOverride: boolean; returnToEstimator?: boolean }

/** The returned (decided) request replaces the stale one and every decision control is switched off. */
export function applyDecision<D extends { request: DecidedLike; can: CanLike }>(detail: D, decided: D["request"]): D {
  return { ...detail, request: decided, can: { decide: false, withdraw: false, reassign: false, needsOverride: false, returnToEstimator: false } };
}

/** The decision panel is shown only for a request that is still PENDING AND that this viewer may act on. */
export function showDecisionPanel(detail: { request: DecidedLike; can: CanLike }): boolean {
  return detail.request.status === "PENDING" && (detail.can.decide || detail.can.withdraw);
}
