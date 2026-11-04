import { assertReadOnlyRequest } from "./policy";
import { RwtsaLiveError, type RwtsaCredentials } from "./types";

export interface ReadOnlyClientOptions {
  creds: RwtsaCredentials;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Minimum gap between requests. Default 1250 ms (about 48/min, under Cin7's 60/min). */
  minIntervalMs?: number;
  maxRetries?: number;
  timeoutMs?: number;
  backoffBaseMs?: number;
}
export interface ReadOnlyClient { get<T = Record<string, unknown>>(path: string, query?: Record<string, string | number>): Promise<T>; requests(): number; methodsUsed(): string[] }

const RETRYABLE = new Set([429, 503]);

/**
 * The module's ONLY network surface: GET, allowlisted paths, the fixed Cin7 origin, redirects refused, a process-local pacer
 * (deliberately NOT the Toolbox's database-backed limiter, so this module never touches the production Supabase).
 */
export function createReadOnlyClient(opts: ReadOnlyClientOptions): ReadOnlyClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? (() => Date.now());
  const minInterval = opts.minIntervalMs ?? 1250;
  const maxRetries = opts.maxRetries ?? 4;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const backoffBase = opts.backoffBaseMs ?? 5000;
  let last = Number.NEGATIVE_INFINITY;
  let count = 0;
  const methods = new Set<string>();

  async function pace(): Promise<void> {
    const wait = Math.max(0, last + minInterval - now());
    if (wait > 0) await sleep(wait);
    last = now();
  }

  return {
    requests: () => count,
    methodsUsed: () => [...methods],
    async get<T>(path: string, query?: Record<string, string | number>): Promise<T> {
      const url = assertReadOnlyRequest("GET", path);
      for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
      for (let attempt = 0; ; attempt++) {
        await pace();
        count++;
        methods.add("GET");
        let res: Response;
        try {
          res = await doFetch(url.toString(), {
            method: "GET",
            headers: { "api-auth-accountid": opts.creds.accountId, "api-auth-applicationkey": opts.creds.applicationKey, accept: "application/json" },
            redirect: "manual",
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch {
          if (attempt >= maxRetries) throw new RwtsaLiveError("NETWORK", `Cin7 could not be reached (${path}).`);
          await sleep(backoffBase * (attempt + 1));
          continue;
        }
        if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) throw new RwtsaLiveError("REDIRECT_REFUSED", `Cin7 answered with a redirect (${path}); it was not followed.`, res.status);
        if (res.status === 401 || res.status === 403) throw new RwtsaLiveError("AUTH_REJECTED", `Cin7 rejected the RWTSA credentials (${path}).`, res.status);
        if (RETRYABLE.has(res.status) || res.status >= 500) {
          if (attempt >= maxRetries) throw new RwtsaLiveError(RETRYABLE.has(res.status) ? "RATE_LIMITED" : "SERVER_ERROR", `Cin7 kept answering ${res.status} (${path}).`, res.status);
          await sleep(backoffBase * (attempt + 1));
          continue;
        }
        if (res.status === 404) throw new RwtsaLiveError("NOT_FOUND", `Cin7 path not found (${path}).`, 404);
        if (!res.ok) throw new RwtsaLiveError("REQUEST_REJECTED", `Cin7 refused the request with ${res.status} (${path}).`, res.status);
        try { return (await res.json()) as T; } catch { throw new RwtsaLiveError("BAD_RESPONSE", `Cin7 returned a body that is not JSON (${path}).`); }
      }
    },
  };
}
