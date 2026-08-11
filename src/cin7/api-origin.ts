// The ONE Cin7 Core API origin this app will ever send credentials to.
//
// SSRF defense: `cin7_instances.base_url` is org-member-editable (see
// settings/instances/actions.ts). If the request host were taken from that value,
// a member could redirect the Account ID + Application Key to an attacker-controlled
// server. So the host is fixed here in server code and any stored base_url is ignored;
// this module is the single source of truth for where Cin7 traffic may go.
//
// No secrets live here — it's pure URL policy, so it stays importable by unit tests
// (the credential/network modules that DO carry secrets add `import "server-only"`).

export const CIN7_API_ORIGIN = "https://inventory.dearsystems.com/ExternalApi/v2";

const CANONICAL = new URL(CIN7_API_ORIGIN);

export class Cin7OriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Cin7OriginError";
  }
}

/**
 * True only for the exact Cin7 API origin and a path within its `/ExternalApi/v2`
 * prefix. Rejects http, credentials-in-URL, any other host (localhost, private IPs,
 * arbitrary domains all fail the exact-hostname check), any explicit port, and any
 * path that escapes the API prefix. Used both to validate a candidate request URL and
 * to refuse a redirect that points off-origin.
 */
export function isAllowedCin7Url(candidate: string): boolean {
  let u: URL;
  try {
    u = new URL(candidate);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username !== "" || u.password !== "") return false;
  if (u.hostname.toLowerCase() !== CANONICAL.hostname) return false;
  if (u.port !== "") return false; // only the implicit 443
  if (u.pathname !== CANONICAL.pathname && !u.pathname.startsWith(CANONICAL.pathname + "/")) return false;
  return true;
}

export function assertAllowedCin7Url(candidate: string): void {
  if (!isAllowedCin7Url(candidate)) {
    throw new Cin7OriginError(`Refusing to send Cin7 credentials to a non-allowlisted URL: ${candidate}`);
  }
}

/**
 * Builds the request URL for a code-supplied API path (e.g. "/product") + optional
 * query, always rooted at the canonical origin. `path` must start with "/". Any
 * attempt to escape the API prefix (`../`, an absolute URL, etc.) is caught by the
 * post-build allowlist assertion, so the returned URL is always on the Cin7 host.
 */
export function buildCin7Url(path: string, query?: Record<string, string | number>): URL {
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new Cin7OriginError(`Cin7 API path must be a string starting with "/": ${String(path)}`);
  }
  const url = new URL(CIN7_API_ORIGIN + path);
  // URL normalization resolves any `..`/`.` segments here; if that pushed the path out
  // of the API prefix (or somehow off-host) this throws rather than issue the request.
  assertAllowedCin7Url(url.toString());
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  }
  return url;
}
