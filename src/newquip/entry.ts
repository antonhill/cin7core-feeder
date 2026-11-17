// NewQuip dedicated sign-in: client-safe, pure helpers shared by middleware, the login page and tests. No secrets live in the entry cookie: it only says "this browser signs in via NewQuip".
export const NEWQUIP_LOGIN_PATH = "/newquip/login";
export const NEWQUIP_ENTRY_COOKIE = "newquip_entry";
export const NEWQUIP_ENTRY_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
export const NEWQUIP_NO_ACCESS_MESSAGE = "This account does not have access to NewQuip.";

/** Routes that belong to NewQuip alone. An unauthenticated request to one is sent to the NewQuip sign-in, never the Toolbox /login. Segment-boundary match ("/projects-x" is not "/projects"). */
export const NEWQUIP_ROUTE_PREFIXES: readonly string[] = ["/newquip-grower", "/projects", "/claims", "/approvals"];

const underPrefix = (pathname: string, prefix: string): boolean => pathname === prefix || pathname.startsWith(`${prefix}/`);

/** True for the NewQuip sign-in page itself and its bare "/newquip" alias (exact matches: "/newquip-grower" must NOT be public). */
export function isNewquipPublicPath(pathname: string): boolean {
  return pathname === "/newquip" || pathname === NEWQUIP_LOGIN_PATH;
}

/** True when an UNAUTHENTICATED request to `pathname` should go to the NewQuip sign-in. "/" counts only when the browser carries the newquip_entry cookie. */
export function isNewquipSignInRoute(pathname: string, hasEntryCookie: boolean): boolean {
  if (pathname === "/") return hasEntryCookie;
  return NEWQUIP_ROUTE_PREFIXES.some((p) => underPrefix(pathname, p));
}

/**
 * Validates a post-sign-in `next` target. Only a same-origin, NewQuip-prefixed path is returned (query allowed); anything else is null.
 * Rejects absolute / protocol-relative URLs, backslashes, control characters, fragments, encoded traversal and dot segments.
 */
export function safeNewquipNext(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null;
  if (raw.includes("#")) return null;
  const qIdx = raw.indexOf("?");
  const path = qIdx === -1 ? raw : raw.slice(0, qIdx);
  const rest = qIdx === -1 ? "" : raw.slice(qIdx);
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return null; }
  const segments = decoded.split("/");
  if (decoded.includes("\\") || decoded.startsWith("//") || decoded.includes("//") || segments.includes("..") || segments.includes(".")) return null;
  if (!NEWQUIP_ROUTE_PREFIXES.some((p) => underPrefix(path, p))) return null;
  return path + rest;
}
