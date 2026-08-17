/**
 * Security re-audit P1-8 / round 3 item 1: the pure, dependency-free half of
 * active-org.ts — split out so middleware.ts (Edge runtime) can share the
 * SAME resolution rule as every Server Action without importing next/headers'
 * `cookies()` (active-org.ts's other export, getActiveOrgCookie, needs it;
 * middleware reads cookies via NextRequest's own API instead — same reason
 * IMPERSONATED_ORG_COOKIE is duplicated rather than imported from
 * org-switch.ts). Round 3's audit found middleware resolving the active org
 * via an unordered `.limit(1)` query — completely ignoring this cookie —
 * while requireCurrentOrg/getCurrentUserInfo correctly honored it, a real
 * role/MFA-gating mismatch for a multi-org user. This module exists so that
 * can never happen again: one function, imported everywhere the decision is
 * made, not reimplemented per caller.
 */
export const ACTIVE_ORG_COOKIE = "active_org_id";

/**
 * Pure selection rule, shared by every caller that needs "which org is this
 * multi-org member currently acting as" (middleware, requireCurrentOrg,
 * getCurrentUserInfo) so they can never disagree with each other.
 * `cookieOrgId` is only honored when it's actually one of `membershipOrgIds`
 * — a stale cookie (membership revoked since it was set) or a tampered one
 * falls through to the deterministic fallback rather than granting access to
 * an org the caller verifies separately isn't actually a real membership.
 *
 * Fallback (no cookie, or an invalid one): the first membership, same
 * behaviour as before this fix for a member who has never explicitly
 * switched — narrowed now to a single, shared, documented rule instead of
 * independently-arbitrary "first row" picks, and superseded the moment the
 * member does explicitly switch (setActiveOrgAction).
 */
export function resolveActiveOrgId(cookieOrgId: string | null, membershipOrgIds: string[]): string | null {
  if (cookieOrgId && membershipOrgIds.includes(cookieOrgId)) return cookieOrgId;
  return membershipOrgIds[0] ?? null;
}
