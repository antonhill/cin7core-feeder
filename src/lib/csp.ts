// Content-Security-Policy builder (pure, dependency-free so next.config.ts can import it).
//
// The Supabase origin the browser may talk to (connect-src for API/auth, img-src for the org-logos
// bucket) is DERIVED from NEXT_PUBLIC_SUPABASE_URL — the same value the client bundle is built with —
// instead of being hard-coded. Production therefore keeps allowing the production origin, and any
// other environment (a branch-specific Preview pointing at an isolated test project, local Supabase)
// allows exactly its own origin, with no per-branch special-casing.
//
// Safety rules:
//   * exactly ONE origin, never a wildcard Supabase domain;
//   * https only — http is accepted solely for loopback hosts (local `supabase start`);
//   * anything unparseable / unsafe / missing yields NO Supabase origin (the policy fails closed to
//     'self'; the app could not reach Supabase in that situation anyway);
//   * every other directive is unchanged.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The single origin to allow for a Supabase URL, or null if the value is missing or not acceptable. */
export function supabaseOriginFromUrl(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  if (u.protocol === "https:") return u.origin;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return u.origin;
  return null;
}

export function buildContentSecurityPolicy(supabaseUrl: string | undefined | null): string {
  const origin = supabaseOriginFromUrl(supabaseUrl);
  const extra = origin ? ` ${origin}` : "";
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data:${extra}`,
    "font-src 'self' data:",
    `connect-src 'self'${extra}`,
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.lemonsqueezy.com",
  ].join("; ");
}
