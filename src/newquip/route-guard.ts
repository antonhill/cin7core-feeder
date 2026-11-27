// NewQuip-only interface: the server-side route allowlist. Client-safe and pure (no server-only imports) so middleware, the nav and tests share ONE list.
//
// A signed-in member of the NewQuip organisation who is NOT a super-admin is a "NewQuip-only" user: they work in the NewQuip workspace and nothing else.
// Middleware redirects every path outside this allowlist to "/" (the NewQuip dashboard). Super-admins bypass the guard entirely. This is a routing gate, not the
// authorisation layer: every route layout and server action still authorises independently.
import { isNewquipPocOrg } from "./access";
import { isGrantedToolboxPath } from "./toolbox-access";

/** Path prefixes a NewQuip-only user may reach. Matched on a segment boundary (so "/projects-x" is NOT "/projects"). "/" is matched exactly, never as a prefix. */
export const NEWQUIP_ONLY_ALLOWED_PREFIXES: readonly string[] = [
  "/newquip-grower",
  "/projects",
  "/approvals",
  "/claims",
  "/settings/members",
  "/settings/security",
  "/settings/notifications",
  // Sign-in, MFA and enrolment flows, and the policy page.
  "/login",
  "/newquip",
  "/auth",
  "/mfa-challenge",
  "/privacy",
  // Route handlers keep their own authentication (bearer token / signature / session); the guard does not narrow them.
  "/api",
];

const underPrefix = (pathname: string, prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** True when a NewQuip-only user may request `pathname`. Pure. Anything that is not clearly on the allowlist is refused (fail closed). */
export function isNewquipOnlyPathAllowed(pathname: string, toolboxGrants: readonly string[] = []): boolean {
  if (typeof pathname !== "string" || !pathname.startsWith("/")) return false;
  if (pathname.includes("\\") || pathname.split("/").includes("..")) return false;
  if (pathname === "/") return true;
  // A main Toolbox module this individual has been explicitly granted (src/newquip/toolbox-access.ts). Empty by default: nobody gets one implicitly.
  if (isGrantedToolboxPath(pathname, toolboxGrants)) return true;
  return NEWQUIP_ONLY_ALLOWED_PREFIXES.some((p) => underPrefix(pathname, p));
}

/** Who the NewQuip-only experience (and its guard) applies to: the NewQuip organisation's non-super-admin members. */
export function isNewquipOnlyUser(orgId: string | null | undefined, isSuperAdmin: boolean): boolean {
  return !isSuperAdmin && orgId != null && isNewquipPocOrg(orgId);
}

/**
 * The middleware decision. `uncertain` is true when the facts that decide who the user is (super-admin lookup, membership lookup) could not be read: the guard then
 * fails closed for non-allowlisted paths only (a redirect to "/", which is harmless), and never loosens any other gate.
 */
export function newquipGuardRedirects(i: { pathname: string; orgId: string | null; isSuperAdmin: boolean; uncertain?: boolean; toolboxGrants?: readonly string[] }): boolean {
  if (i.isSuperAdmin) return false; // a positively identified super-admin always bypasses
  if (isNewquipOnlyPathAllowed(i.pathname, i.toolboxGrants ?? [])) return false;
  if (i.uncertain) return true;
  return isNewquipOnlyUser(i.orgId, i.isSuperAdmin);
}
