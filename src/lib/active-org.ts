import { cookies } from "next/headers";

/**
 * Security re-audit P1-8: cookie recording which org a multi-org member is
 * currently acting as — explicit, not "whichever membership row Postgres
 * happened to return first." Distinct from org-switch.ts's
 * IMPERSONATED_ORG_COOKIE: that one lets a super-admin view an org they
 * AREN'T a member of; this one only ever selects among a real member's own
 * `org_members` rows (never trusted on its own — see resolveActiveOrgId).
 */
export const ACTIVE_ORG_COOKIE = "active_org_id";

/**
 * Pure selection rule, shared by every caller that needs "which org is this
 * multi-org member currently acting as" (requireCurrentOrg, getCurrentUserInfo)
 * so they can never disagree with each other. `cookieOrgId` is only honored
 * when it's actually one of `membershipOrgIds` — a stale cookie (membership
 * revoked since it was set) or a tampered one falls through to the
 * deterministic fallback rather than granting access to an org the caller
 * verifies separately isn't actually a real membership.
 *
 * Fallback (no cookie, or an invalid one): the first membership, same
 * behaviour as before this fix for a member who has never explicitly
 * switched — narrowed now to a single, shared, documented rule instead of
 * two independently-arbitrary "first row" picks, and superseded the moment
 * the member does explicitly switch (setActiveOrgAction).
 */
export function resolveActiveOrgId(cookieOrgId: string | null, membershipOrgIds: string[]): string | null {
  if (cookieOrgId && membershipOrgIds.includes(cookieOrgId)) return cookieOrgId;
  return membershipOrgIds[0] ?? null;
}

/** Reads the raw cookie value (unverified — callers must check it against the caller's real memberships via resolveActiveOrgId). */
export async function getActiveOrgCookie(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(ACTIVE_ORG_COOKIE)?.value ?? null;
}
