import type { Cin7Credentials } from "@/cin7/types";

/** Cin7 Core returns 503 (not 429) when the 60/min limit is hit, with no Retry-After header. */
export class Cin7ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public retryable: boolean
  ) {
    super(message);
    this.name = "Cin7ApiError";
  }
}

export interface Cin7RequestOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  query?: Record<string, string | number>;
}

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2000;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function minIntervalMs(): number {
  const rps = Number(process.env.RATE_LIMIT_RPS ?? "1");
  return 1000 / Math.max(rps, 0.1);
}

// Module-level so pacing holds across every call within (and across warm
// invocations of) a single sync run — Cin7's limit is per API application,
// not per request.
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + minIntervalMs() - Date.now();
  if (wait > 0) await sleep(wait);
  lastCallAt = Date.now();
}

/** Test-only: fake timers can leave lastCallAt referencing a stale fake clock. */
export function __resetRateLimiterForTests() {
  lastCallAt = 0;
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
  const url = new URL(`${creds.baseUrl.replace(/\/$/, "")}${path}`);
  if (options.query) {
    for (const [key, value] of Object.entries(options.query)) url.searchParams.set(key, String(value));
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle();

    let response: Response;
    try {
      response = await fetch(url.toString(), {
        method: options.method ?? "GET",
        headers: {
          "api-auth-accountid": creds.accountId,
          "api-auth-applicationkey": creds.applicationKey,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
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

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * (attempt + 1));
        continue;
      }
      throw new Cin7ApiError(
        0,
        `Network error on ${options.method ?? "GET"} ${path} after ${attempt + 1} attempt(s): ${detail}`,
        true
      );
    }

    if (response.status === 503) {
      if (attempt < MAX_RETRIES) {
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
      // shared 60/min ceiling over the top from combined call volume.
      const isRateLimitedNonStandard = /reached 60 calls per 60 seconds/i.test(body);
      if (isRateLimitedNonStandard && attempt < MAX_RETRIES) {
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
