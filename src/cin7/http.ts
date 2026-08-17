import "server-only";
import type { Cin7Credentials } from "@/cin7/types";
import { buildCin7Url } from "@/cin7/api-origin";
import { acquireCin7Slot, reportCin7RateLimitCooldown } from "@/cin7/rate-limit";

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
  /**
   * Security re-audit P0-4: an overall wall-clock budget for THIS call,
   * covering every attempt's fetch AND every sleep between them — distinct
   * from `timeoutMs` (bounds one attempt's network time) and `maxRetries`
   * (bounds attempt count, but not elapsed time: MAX_RETRIES backoff sleeps
   * alone can already total ~1.75 minutes, before any fetch time). Without
   * this, retry sleeps and stalled requests together could consume most of
   * a Vercel invocation's own duration budget on a single cin7Request call.
   * Defaults to DEFAULT_OPERATION_TIMEOUT_MS.
   */
  operationTimeoutMs?: number;
}

// The distributed Postgres-backed token bucket (migration 0075, P0-3) is the
// ONLY pacing mechanism now. Security re-audit round 3, item 3.1: a prior
// in-memory per-invocation throttle used to exist here as a fallback for GET
// requests when the distributed coordinator was unavailable/contended
// ("degrade" outcome) — but that fallback let the real HTTP request through
// completely unaccounted by the shared bucket, reopening exactly the
// multi-worker uncoordinated-traffic race P0-3 was built to close, just
// scoped to reads. A "degrade" outcome is now treated identically to
// "blocked": the request does not proceed unpaced on this attempt — it
// retries the whole attempt through the existing maxRetries/backoff loop
// below, or fails clearly once exhausted. See acquireCin7Slot's own comment
// for why "degrade"/"blocked" remain distinct return values (still useful
// for future observability) even though this function now handles them the
// same way.
const MAX_RETRIES = 6;
const RETRY_BASE_DELAY_MS = 5000;
// Security re-audit P0-4: a single attempt's own network deadline — generous
// enough for Cin7's slower paginated/reporting endpoints, but bounded so a
// truly stalled connection can't silently consume the rest of a Vercel
// invocation's duration budget (see MAX_RETRIES' own comment on why retries
// already run with real backoff between them — this timeout is orthogonal,
// it bounds each individual attempt, not the whole retry loop).
const DEFAULT_TIMEOUT_MS = 20_000;
// Security re-audit P0-3: a fixed, shared cooldown pushed into the
// distributed bucket after a real Cin7 503/equivalent — deliberately NOT
// scaled by this invocation's own attempt number, since it's a signal for
// every OTHER invocation sharing the bucket, not this one's personal backoff
// schedule.
const CIN7_503_COOLDOWN_MS = 10_000;
// Security re-audit P0-4: the whole-call budget (see operationTimeoutMs
// above). 60s comfortably covers a legitimate multi-attempt retry sequence
// while staying well under every route's own Vercel maxDuration (60-300s) —
// most routes make many cin7Request calls per invocation, not one, so this
// is a per-call budget, not the invocation's entire duration.
const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  // Security re-audit P0-4: covers every attempt's fetch AND every sleep
  // between them — checked at the top of each loop iteration, so a call
  // already past its budget fails fast instead of starting one more
  // (possibly ~30s-backoff-plus-20s-timeout) attempt.
  const operationDeadline = Date.now() + (options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
  // Security re-audit round 3, item 4: every retry-backoff sleep in this
  // function is clamped through this one helper — a sleep is never allowed
  // to run longer than what's actually left of the whole-call budget.
  // Floored at 0 (not 1, unlike the quota-wait/fetch-timeout clamps above):
  // an already-expired budget just makes this an ~instant sleep(0); the
  // top-of-loop deadline check (attempt is always > 0 right after any of
  // these sleeps) throws the real, correctly-worded error on the very next
  // iteration instead.
  const clampedBackoff = (attempt: number) => sleep(Math.max(0, Math.min(RETRY_BASE_DELAY_MS * (attempt + 1), operationDeadline - Date.now())));

  // Security re-audit P0-3: a real WRITE must never bypass the distributed
  // coordinator — only a read may degrade to the in-memory per-invocation
  // throttle when the coordinator is unavailable/contended. GET is the only
  // Cin7 call this codebase ever treats as read-only; everything else is a
  // write for pacing purposes even when it isn't for retry-safety purposes
  // (a different, narrower question — see nonIdempotentCreate above).
  const isWrite = (options.method ?? "GET") !== "GET";

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // Security re-audit P0-4: fail fast rather than starting another attempt
    // (its own up-to-timeoutMs fetch plus up-to-30s backoff) once the whole
    // call's budget is already spent.
    if (attempt > 0 && Date.now() >= operationDeadline) {
      throw new Cin7ApiError(
        0,
        `${options.method ?? "GET"} ${path} exceeded its ${options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS}ms operation deadline after ${attempt} attempt(s)`,
        true
      );
    }

    // Security re-audit round 3, item 4: recomputed fresh right before each
    // potentially-blocking operation below (quota wait, fetch timeout,
    // backoff sleep) rather than once at the top of the loop — time already
    // spent this iteration (e.g. a slow acquireCin7Slot call) must shrink
    // what's left for the NEXT blocking operation too. Floored at 1ms rather
    // than 0 so attempt 0 always gets a genuine (if minimal) real attempt
    // regardless of how small/expired operationTimeoutMs already is — the
    // top-of-loop check above is what actually enforces "no attempt after
    // attempt 0 starts once the deadline has passed."
    const remainingForAcquire = Math.max(1, operationDeadline - Date.now());

    // Cross-invocation distributed limiter (Postgres token bucket, migration
    // 0075) — the ONLY pacing mechanism now (security re-audit round 3, item
    // 3.1 — see this file's top-of-module comment). Its own internal wait is
    // now bounded by remainingForAcquire (item 4) — it can't itself consume
    // more of this call's budget than is actually left.
    const acquireOutcome = await acquireCin7Slot(creds.accountId, creds.applicationKey, {
      allowDegrade: !isWrite,
      maxWaitMs: remainingForAcquire,
    });

    if (acquireOutcome === "blocked" || acquireOutcome === "degrade") {
      // The coordinator is unavailable or still contended. Cin7 itself was
      // never contacted this attempt, so this is unambiguous (unlike a lost
      // network response): safe to retry the whole attempt (a fresh
      // acquireCin7Slot call next time round), bounded by the same
      // maxRetries/backoff this function already uses for everything else.
      // "degrade" (a read whose coordinator call couldn't be resolved) is
      // treated identically to "blocked" (a write) — neither proceeds
      // unpaced; see this file's top-of-module comment for why the old
      // read-only local-throttle fallback was removed.
      if (attempt < maxRetries) {
        await clampedBackoff(attempt);
        continue;
      }
      throw new Cin7ApiError(
        0,
        `Rate limit coordinator unavailable or contended; refusing to send ${options.method ?? "GET"} ${path} unpaced after ${attempt + 1} attempt(s)`,
        true
      );
    }
    // "granted" — proceed directly.

    // Item 4: the fetch's own AbortSignal timeout must not outlive the whole
    // call's remaining budget — recomputed fresh here since the quota
    // acquisition above may itself have consumed real time this iteration.
    const attemptTimeoutMs = Math.max(1, Math.min(timeoutMs, operationDeadline - Date.now()));

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
        // Security re-audit P0-4/round-3-item-4: bounds THIS attempt only —
        // a stalled connection throws (caught below) instead of hanging
        // forever — clamped to whatever's actually left of the whole-call
        // budget, not always the fixed configured timeoutMs.
        signal: AbortSignal.timeout(attemptTimeoutMs),
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
        await clampedBackoff(attempt); // security re-audit round 3, item 4
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
      // Security re-audit P0-3: Cin7's own authoritative "you're over
      // budget" signal — push a shared cooldown so every OTHER invocation
      // coordinating through this bucket backs off too, not just this one.
      // Best-effort: never throws, never blocks this call's own handling.
      await reportCin7RateLimitCooldown(creds.accountId, creds.applicationKey, CIN7_503_COOLDOWN_MS);
      if (attempt < maxRetries) {
        await clampedBackoff(attempt); // security re-audit round 3, item 4
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
      if (isRateLimitedNonStandard) {
        // Same reasoning as the 503 branch above — the same underlying
        // condition, just reported differently by this endpoint family.
        await reportCin7RateLimitCooldown(creds.accountId, creds.applicationKey, CIN7_503_COOLDOWN_MS);
        if (attempt < maxRetries) {
          await clampedBackoff(attempt); // security re-audit round 3, item 4
          continue;
        }
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
 * retry/backoff loop: these are exploratory probes over many candidate
 * paths, already self-paced by their own caller between calls (a fixed
 * manual sleep, not a bounded retry sequence like cin7Request's).
 *
 * Security re-audit round 3, item 3.2: DOES still acquire a real distributed
 * quota token first, though — this used to be the one credential-bearing
 * Cin7 request path with zero quota participation of any kind (not even the
 * old in-memory throttle), consuming real 60/min budget completely
 * unaccounted by the shared bucket every other caller coordinates through.
 * A single acquire attempt (no retry loop, matching this function's own
 * no-retry design) throws a clear, typed error on anything but "granted" —
 * every caller in debug.ts already wraps each candidate-path call in its own
 * try/catch and records a failed probe result, so this fits the existing
 * per-path error-tolerant control flow without any caller change needed.
 */
export async function cin7RawRequest(creds: Cin7Credentials, path: string, query?: Record<string, string | number>): Promise<Cin7RawResponse> {
  const acquireOutcome = await acquireCin7Slot(creds.accountId, creds.applicationKey, { allowDegrade: false });
  if (acquireOutcome !== "granted") {
    throw new Cin7ApiError(0, `Rate limit coordinator unavailable or contended; refusing to send GET ${path} unpaced`, true);
  }

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
