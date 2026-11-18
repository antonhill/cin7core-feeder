// The stale-PENDING window, in its own dependency-free module so client-safe code (claim-cin7-status, commercial-billing-state) can use the SAME rule the
// posting flow uses without importing cin7-posting (which needs node:crypto). cin7-posting re-exports both names unchanged.

/** A PENDING row older than this is presumed orphaned (the process died mid-call) and must be reconciled before anything else. */
export const STALE_PENDING_MS = 5 * 60 * 1000;

export const isStalePending = (requestedAt: string, now: number = Date.now()): boolean => now - Date.parse(requestedAt) > STALE_PENDING_MS;
