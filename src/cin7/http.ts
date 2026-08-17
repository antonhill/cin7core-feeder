import "server-only";
import type { Cin7Credentials } from "@/cin7/types";
import { buildCin7Url } from "@/cin7/api-origin";
import { acquireCin7Slot } from "@/cin7/rate-limit";

/** Cin7 Core returns 503 (not 429) when the 60/min limit is hit, with no Retry-After header. */
export class Cin7ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryable: boolean,
    /**
     * Security re-audit P0-2: true when this was a `nonIdempotentCreate`
     * request (see below) that failed with a network-level error — Cin7 may
     * or may not have actually committed the write before the response was
     * lost, so the caller must NOT blindly retry or release any idempotency
     * claim it's holding; it needs to reconcile (e.g. look the record up by
     * a stable reference) first. Always false for every other failure —
     * a definite rejection (503, 400, a redirect, a non-JSON 200) means
     * Cin7 told us something, which isn't ambiguous.
     */
    public ambiguous: boolean = false
  ) {
    super(message);
    this.name = "Cin7ApiError";
  }
}

export interface Cin7RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number>;
  /**
   * Security re-audit P0-1/P0-4: overrides the default retry ceiling
   * (MAX_RETRIES) — e.g. 0 for a diagnostic/connectivity check that wants a
   * single fast attempt and an immediate answer, instead of up to ~2.5
   * minutes of backoff before the caller ever hears back.
   */
  maxRetries?: number;
  /**
   * Security re-audit P0-4: per-attempt network deadline in ms, enforced via
   * `AbortSignal.timeout()` on every fetch — a stalled connection (not a
   * clean error, just silence) must not hang indefinitely and eat the whole
   * Vercel invocation's duration budget. Defaults to DEFAULT_TIMEOUT_MS.
   */
  timeoutMs?: number;
  /**
   * Security re-audit P0-2: set this for a request that CREATES a brand new
   * financial/inventory document each time it succeeds — a Purchase Order,
   * a Stock Transfer — where retrying after losing the response risks a
   * silent duplicate. Deliberately NOT inferred from `method === "POST"`:
   * Cin7's own API uses POST for some genuinely idempotent calls too (e.g.
   * marking a sale shipped is a POST but re-sending it after an ambiguous
   * failure doesn't create a second shipment), so this needs each call
   * site's own judgment, not a blanket HTTP-verb rule. When true, a
   * network-level failure throws IMMEDIATELY as an ambiguous Cin7ApiError —
   * no retry attempts at all — instead of silently resending a request that
   * may have already landed.
   */
  nonIdempotentCreate?: boolean;
}

// Quick mitigation (2026-07-24, after Supplier Planner's live paginated
// fetch hit "60 calls per 60 seconds" against a real large-catalog account):
// the in-memory throttle below only paces calls *within one serverless
// invocation* — it can't see a concurrent Vercel Cron sync (e.g.
// /api/sync-product-availability) hitting the same Cin7 account from a
// separate invocation at the same time, so the combined real call volume
// can exceed 60/60s even when every individual invocation believes it's
// pacing at a safe rate. A real fix needs a cross-invocation limiter (e.g.
// Postgres-backed token bucket); until then, running the default pace with
// real headroom below the limit (not exactly at it) and giving a persistent
// rate-limit response more patience to retry through gives day-to-day
// coverage without that bigger piece of work.
const MAX_RETRIES = 6;
const RETRY_BASE_DELAY_MS = 5000;
// Security re-audit P0-4: a single attempt's own network deadline — generous
// enough for Cin7's slower paginated/reporting endpoints, but bounded so a
// truly stalled connection can't silently consume the rest of a Vercel
// invocation's duration budget (see MAX_RETRIES' own comment on why retries
// already run with real backoff between them — this timeout is orthogonal,
// it bounds each individual attempt, not the whole retry loop).
const DEFAULT_TIMEOUT_MS = 20_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minIntervalMs(): number {
  const rps = Number(process.env.RATE_LIMIT_RPS ?? "0.8");
  return 1000 / Math.max(rps, 0.1);
}

// Module-level so pacing holds across every call within (and across warm
// invocations of) a single sync run — Cin7's limit is per API application,
// not per request. Keyed by accountId (not baseUrl+accountId): accountId is
// the real per-tenant identity Cin7 enforces its 60/min ceiling against, so
// two Cin7Credentials sharing an accountId genuinely share the same upstream
// quota bucket regardless of hostname — throttling them together is
// correct, not a bug to guard against. Confirmed live 2026-07-11 this was
// previously a SINGLE global gate shared across every instance, needlessly
// serializing two completely independent Cin7 accounts' own 60/min budgets
// through one combined 1/sec pace — this is what let per-instance
// concurrency (sync-org.ts) actually speed anything up.
const lastCallAtByAccount = new Map<string, number>();

// A per-account FIFO queue, not just a shared timestamp — callers that fire
// concurrently (e.g. pull-instance.ts's Promise.all over products/customers/
// suppliers, all against the same account) must genuinely take turns, not
// each read the same stale lastCallAt before any of them has slept and
// written it back. That race (confirmed live 2026-07-21: several concurrent
// callers computing the same wake-up time and firing together) let bursts
// through fast enough to trip Cin7's 60-calls/60s limit despite RATE_LIMIT_RPS
// being 1. Chaining every call onto the same account's queue tail forces
// them through the read→sleep→write sequence one at a time.
const throttleQueueByAccount = new Map<string, Promise<void>>();

function throttle(accountId: string): Promise<void> {
  const previous = throttleQueueByAccount.get(accountId) ?? Promise.resolve();
  const next = previous.then(async () => {
    const lastCallAt = lastCallAtByAccount.get(accountId) ?? 0;
    const wait = lastCallAt + minIntervalMs() - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAtByAccount.set(accountId, Date.now());
  });
  throttleQueueByAccount.set(accountId, next);
  return next;
}

/** Test-only: fake timers can leave lastCallAtByAccount/throttleQueueByAccount referencing a stale fake clock. */
export function __resetRateLimiterForTests() {
  lastCallAtByAccount.clear();
  throttleQueueByAccount.clear();
}

/**
 * Makes an authenticated Cin7 Core API request, self-throttled to
 * RATE_LIMIT_RPS and retrying with a fixed backoff on 503 (no Retry-After
 * header is documented, so we can't honour one).
 */
export async function cin7Request<T>(
  creds: Cin7Credentials,
  path: string,
  options: Cin7RequestOptions = {}
): Promise<T> {
  // Host is fixed by buildCin7Url (the canonical Cin7 origin) — creds.baseUrl is deliberately
  // NOT used, so an org-member-editable base_url can never redirect credentials elsewhere.
  const url = buildCin7Url(path, options.query);
  const maxRetries = options.maxRetries ?? MAX_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Cross-invocation distributed limiter (Postgres token bucket, migration
    // 0054) — the real fix for the multi-invocation problem the throttle below
    // can't solve. If it's unavailable (DB blip, or the migration isn't applied
    // yet), fall back to the in-memory per-invocation throttle so a limiter
    // outage never halts Cin7 traffic and behaviour stays exactly as it was.
    const pacedByDistributedLimiter = await acquireCin7Slot(creds.accountId);
    if (!pacedByDistributedLimiter) await throttle(creds.accountId);

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: options.method ?? "GET",
        // Never auto-follow a redirect: it could send the Account ID + Application Key to
        // a different origin. With "manual", undici returns the 3xx response unfollowed and
        // we reject it below rather than leaking credentials off the allowlisted host.
        redirect: "manual",
        headers: {
          "api-auth-accountid": creds.accountId,
          "api-auth-applicationkey": creds.applicationKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        // Security re-audit P0-4: bounds THIS attempt only — a stalled
        // connection throws (caught below) instead of hanging forever.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Retry like a 503 — a raw fetch failure (DNS blip, connection reset,
      // timeout) may well be transient. Node's fetch (undici) often carries
      // the real underlying reason in `cause`, which was previously
      // discarded — surfacing it here since a bare "fetch failed" gave no
      // way to tell a transient network issue from a structural bug.
      const cause = e instanceof Error && "cause" in e ? (e as { cause?: unknown }).cause : undefined;
      const causeText = cause ? (cause instanceof Error ? cause.message : JSON.stringify(cause)) : undefined;
      const detail = [e instanceof Error ? e.message : String(e), causeText].filter(Boolean).join(" | cause: ");

      // Security re-audit P0-2: a network-level failure on a
      // nonIdempotentCreate request is AMBIGUOUS — Cin7 may have already
      // committed the write before the response was lost. Blindly retrying
      // here (the old behavior, for every method) is exactly how a
      // duplicate PO/stock-transfer/other create gets made; the caller must
      // reconcile before deciding whether to retry, not this function —
      // so this throws immediately, on the very first failure, no retries.
      if (options.nonIdempotentCreate) {
        throw new Cin7ApiError(
          0,
          `Ambiguous outcome on ${options.method ?? "GET"} ${path} — network error, Cin7's response was lost; the write may or may not have committed. Reconcile before retrying: ${detail}`,
          false,
          true
        );
      }

      if (attempt < maxRetries) {
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new Cin7ApiError(
        0,
        `Network error on ${options.method ?? "GET"} ${path} after ${attempt + 1} attempt(s): ${detail}`,
        true
      );
    }

    // A redirect off the (single, allowlisted) Cin7 origin is never legitimate for an API
    // call and must not be followed — treat any 3xx (or an opaque redirect) as a hard error.
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
      throw new Cin7ApiError(
        response.status || 0,
        `Cin7 API returned a redirect (${response.headers.get("location") ?? "no location"}) on ${options.method ?? "GET"} ${path}; refusing to follow it off-origin.`,
        false
      );
    }

    if (response.status === 503) {
      if (attempt < maxRetries) {
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new Cin7ApiError(503, "Rate limited (60 calls/min) and retries exhausted", true);
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");

      // Confirmed live 2026-07-09: /purchase and /advanced-purchase signal
      // the 60-calls-per-60-seconds limit via a non-503 status with this
      // exact message, unlike /saleList etc which use a real 503 — the same
      // underlying condition, just reported differently by this endpoint
      // family. Retried the same way as a 503, since self-throttling only
      // paces calls *within* one invocation; a concurrent cron run (e.g.
      // /api/sync firing at the same time) can still push the account's
      // shared 60/min ceiling over the top from combined call volume. Not
      // ambiguous — Cin7 responded and told us it declined the request, so
      // this stays retried regardless of nonIdempotentCreate.
      const isRateLimitedNonStandard = /reached 60 calls per 60 seconds/i.test(body);
      if (isRateLimitedNonStandard && attempt < maxRetries) {
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }

      // Validation error arrays can list many missing fields at once — a
      // short truncation was hiding all but the first one or two, forcing
      // multiple slow round-trips to discover each subsequent field.
      throw new Cin7ApiError(response.status, body.slice(0, 4000) || response.statusText, isRateLimitedNonStandard);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 200 with a non-JSON body (usually HTML) has twice now meant the
      // path itself is wrong (Cin7 falls through to some default page
      // rather than 404ing) — surfacing the method/path/body snippet here
      // instead of a bare JSON.parse error with no request context.
      throw new Cin7ApiError(
        response.status,
        `${options.method ?? "GET"} ${path} returned a 200 with a non-JSON body (likely wrong path): ${text.slice(0, 300)}`,
        false
      );
    }
  }

  throw new Cin7ApiError(0, "Unreachable", false);
}

export interface Cin7RawResponse {
  status: number;
  text: string;
}

/**
 * Security re-audit P0-1: the ONE sanctioned escape hatch from cin7Request —
 * for diagnostics (cin7/debug.ts's path/field probes) that need to inspect a
 * raw response cin7Request would otherwise throw away, e.g. a candidate path
 * that returns 200 with an HTML "page not found" body: that non-JSON body
 * IS the signal being tested for, not an error to surface. Still goes
 * through the canonical origin (buildCin7Url) and the same
 * headers/redirect-safety rules as cin7Request — no other function in this
 * codebase may call fetch() with Cin7 credentials attached (enforced by
 * src/test/__tests__/cin7-gateway-boundary.test.ts). Deliberately no
 * retry/rate-limit backoff: these are exploratory probes over many candidate
 * paths, already self-paced by their own caller between calls.
 */
export async function cin7RawRequest(creds: Cin7Credentials, path: string, query?: Record<string, string | number>): Promise<Cin7RawResponse> {
  const url = buildCin7Url(path, query);
  const response = await fetch(url.toString(), {
    method: "GET",
    redirect: "manual",
    headers: {
      "api-auth-accountid": creds.accountId,
      "api-auth-applicationkey": creds.applicationKey,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text().catch(() => "");
  return { status: response.type === "opaqueredirect" ? 0 : response.status, text };
}
