/**
 * Host / Origin validation for the standalone, local-only demonstration app. Pure and fail-closed.
 *
 * The server listens on 127.0.0.1, but a browser can still be steered at it by a hostile page (DNS rebinding: the attacker's
 * name resolves to 127.0.0.1, so Host and Origin both carry the attacker's name and still match each other). Only these
 * names are ever served, on any port. Anything else, including a missing Host, is refused.
 */

export const ALLOWED_HOSTNAMES: readonly string[] = ["127.0.0.1", "localhost", "[::1]"];

const HOST_RE = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/i;

export function isLoopbackHost(host: string | null | undefined): boolean {
  if (host === null || host === undefined) return false;
  const m = HOST_RE.exec(host);
  if (!m) return false;
  return m[2] === undefined || Number(m[2]) <= 65535;
}

/** True when `origin` (a full origin such as http://127.0.0.1:3100) names exactly the same loopback host as the request's Host. */
export function originMatchesHost(origin: string, host: string | null): boolean {
  if (!isLoopbackHost(host)) return false;
  const m = /^https?:\/\/([^/?#\s@]+)$/i.exec(origin);
  return m !== null && isLoopbackHost(m[1]) && m[1].toLowerCase() === (host as string).toLowerCase();
}

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export type GuardResult = { readonly ok: true } | { readonly ok: false; readonly reason: "host" | "forwarded-host" | "origin" };

/** Decides whether a request may be served. `headers` is any object with a case-insensitive `get`. */
export function guardRequest(method: string, headers: { get(name: string): string | null }): GuardResult {
  const host = headers.get("host");
  if (!isLoopbackHost(host)) return { ok: false, reason: "host" };
  const fwd = headers.get("x-forwarded-host");
  if (fwd !== null && !isLoopbackHost(fwd)) return { ok: false, reason: "forwarded-host" };
  if (MUTATING.has(method.toUpperCase())) {
    const origin = headers.get("origin");
    if (origin !== null) {
      if (!originMatchesHost(origin, host)) return { ok: false, reason: "origin" };
    } else if (headers.get("sec-fetch-site") !== "same-origin") {
      return { ok: false, reason: "origin" };
    }
  }
  return { ok: true };
}
