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
      // Validation error arrays can list many missing fields at once — a
      // short truncation was hiding all but the first one or two, forcing
      // multiple slow round-trips to discover each subsequent field.
      throw new Cin7ApiError(response.status, body.slice(0, 4000) || response.statusText, false);
    }

    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  throw new Cin7ApiError(0, "Unreachable", false);
}
