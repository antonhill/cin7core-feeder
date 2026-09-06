import { Cin7ApiError } from "@/cin7/http";

/**
 * How a catalog-push failure is classified, and how long a deterministic one
 * may be left alone.
 *
 * Pure by design: the decision is a function of state the caller already
 * holds, so it is testable without a database, a Cin7 client, or a clock.
 */

/**
 * Decided STRUCTURALLY — by where the failure happened and what the gateway
 * already knows — never by matching text in an error message. That matters
 * because production shows the two kinds sitting side by side in the same
 * `failed` state: of LBL's 3,876 failures, 3,864 are deterministic reference
 * problems, but 7 are genuine 429/502 responses. A text rule that happened to
 * miss those would suppress a rate limit as though it were a missing account.
 */
export type SyncFailureClass =
  /** Pre-flight found a missing reference. No Cin7 call was made. Deterministic. */
  | "reference_validation"
  /** Cin7 answered and declined, non-retryably (e.g. duplicate SKU). Deterministic. */
  | "rejected"
  /** Cin7ApiError.retryable — 429, 502, network. Must keep retrying. */
  | "transient"
  /** Cin7ApiError.ambiguous — a possibly-committed non-idempotent write. */
  | "ambiguous"
  /** Anything else, including non-Cin7 errors. Unrecognised must not mean ignorable. */
  | "unknown";

/**
 * The only classes that may ever be suppressed.
 *
 * `ambiguous` is deliberately excluded and must stay excluded: a
 * possibly-committed write is not a configuration problem, and the existing
 * reconciliation path is authoritative for it. `unknown` is excluded because
 * suppressing what we could not classify is exactly how a real defect becomes
 * invisible.
 */
const SUPPRESSIBLE: ReadonlySet<SyncFailureClass> = new Set<SyncFailureClass>(["reference_validation", "rejected"]);

export function isSuppressibleFailureClass(cls: SyncFailureClass | null | undefined): boolean {
  return cls != null && SUPPRESSIBLE.has(cls);
}

/**
 * Classifies a failure thrown from the push itself (i.e. after pre-flight
 * passed). Pre-flight failures never reach here — the caller records those as
 * `reference_validation` at their own site, which is what makes that class
 * trustworthy.
 */
export function classifyPushError(error: unknown): SyncFailureClass {
  // The push path wraps a failure for readability before it reaches the
  // policy, so look through one level of `cause` as well as at the error
  // itself. Without this every transient 429 classified as "unknown" — which
  // a test caught, and which would have made this whole policy blind to the
  // one distinction it must never get wrong.
  const cin7 =
    error instanceof Cin7ApiError
      ? error
      : (error as { cause?: unknown } | null | undefined)?.cause instanceof Cin7ApiError
        ? ((error as { cause: Cin7ApiError }).cause)
        : null;

  if (!cin7) return "unknown";
  // Order matters: an ambiguous error is also non-retryable, and ambiguity is
  // the stronger statement about what we know.
  if (cin7.ambiguous) return "ambiguous";
  return cin7.retryable ? "transient" : "rejected";
}

/**
 * Backoff for a deterministic failure, by consecutive attempt count.
 *
 * Deliberately starts short and caps low. The cause is usually a reference
 * book someone is actively fixing, so the first re-attempt lands within the
 * hour; the cap bounds the worst case at six hours, which is the promise that
 * "corrected but still suppressed" can never become permanent even if the
 * fingerprint misses the change entirely.
 */
export const RETRY_BACKOFF_MINUTES: readonly number[] = [15, 60, 180, 360];
export const MAX_RETRY_BACKOFF_MINUTES = RETRY_BACKOFF_MINUTES[RETRY_BACKOFF_MINUTES.length - 1];

export function backoffMinutesFor(consecutiveFailures: number): number {
  if (consecutiveFailures <= 1) return RETRY_BACKOFF_MINUTES[0];
  const idx = Math.min(consecutiveFailures - 1, RETRY_BACKOFF_MINUTES.length - 1);
  return RETRY_BACKOFF_MINUTES[idx];
}

/**
 * The sync_state row's own shape, snake_case as it comes back from the
 * database — deliberately not a camelCase mirror, so there is no mapping layer
 * to drift out of step with the column names.
 */
export interface SyncFailureState {
  last_status: string | null;
  failure_class: string | null;
  failure_fingerprint: string | null;
  next_retry_at: string | null;
}

/**
 * Whether a product whose content differs from its last successful push may be
 * skipped this run.
 *
 * Every condition must hold, and each removes a distinct way this could go
 * wrong:
 *
 *  - the row's last outcome was a failure — a success is handled by the
 *    ordinary content-hash comparison, not here;
 *  - the class is one we are willing to suppress — never transient, ambiguous
 *    or unknown;
 *  - the content is unchanged since the failure — an edited product is a new
 *    attempt and deserves one immediately, which is the recovery path a user
 *    would expect without knowing this mechanism exists;
 *  - the backoff has not yet elapsed — the bound that stops suppression from
 *    outliving a fix it could not observe.
 */
export function shouldSuppressRetry(state: SyncFailureState, currentContentHash: string, now: Date): boolean {
  if (state.last_status !== "failed") return false;
  if (!isSuppressibleFailureClass(state.failure_class as SyncFailureClass)) return false;
  if (state.failure_fingerprint == null || state.failure_fingerprint !== currentContentHash) return false;
  if (state.next_retry_at == null) return false;

  return new Date(state.next_retry_at).getTime() > now.getTime();
}

/**
 * The suppression fields to persist alongside a failure.
 *
 * Returns `next_retry_at: null` — eligible immediately — for any class we do
 * not suppress, so a transient failure keeps its current behaviour exactly.
 */
export function failureStateUpdate(
  failureClass: SyncFailureClass,
  contentHash: string,
  priorConsecutiveFailures: number,
  now: Date
): { failure_class: SyncFailureClass; failure_fingerprint: string; consecutive_failures: number; next_retry_at: string | null } {
  const consecutive = priorConsecutiveFailures + 1;
  const suppressible = isSuppressibleFailureClass(failureClass);
  const nextRetryAt = suppressible ? new Date(now.getTime() + backoffMinutesFor(consecutive) * 60_000).toISOString() : null;

  return {
    failure_class: failureClass,
    failure_fingerprint: contentHash,
    consecutive_failures: consecutive,
    next_retry_at: nextRetryAt,
  };
}

/** Cleared on any successful push, so a recovered product carries no residue. */
export const CLEARED_FAILURE_STATE = {
  failure_class: null,
  failure_fingerprint: null,
  consecutive_failures: 0,
  next_retry_at: null,
} as const;
