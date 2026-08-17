import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { getImpersonatedOrgId } from "@/lib/org-switch";
import { getActiveOrgCookie, resolveActiveOrgId } from "@/lib/active-org";

export interface CurrentOrg {
  userId: string;
  orgId: string;
  email: string | null;
}

/**
 * Derives the current session's org from org_members — this, not the old
 * shared passphrase, is the real authorization boundary now: a request can
 * only act on an org the logged-in user is actually a member of, not any org
 * whose UUID happens to be known (which the shared-passphrase design never
 * actually prevented, since one passphrase worked for every org).
 *
 * Security re-audit P1-8: a member of more than one org now has an EXPLICIT
 * active-org selection (the active_org_id cookie, set via setActiveOrgAction
 * — see src/lib/active-org.ts's resolveActiveOrgId for the shared rule),
 * instead of an implicit, DB-row-order-dependent "first membership." Without
 * ever switching, the first membership is still used (same as before) — but
 * now via the one shared rule getCurrentUserInfo (the nav) also calls, so
 * the two can never disagree about which org is "current."
 *
 * **Exception: a super-admin "viewing as" another org** (see
 * src/actions/org-switch.ts) — checked first, since Anton explicitly wanted
 * master-user access to any org without needing an `org_members` row there.
 * The impersonation cookie is re-verified against a real super-admin check
 * on every call here, not trusted on its own.
 */
export async function requireCurrentOrg(): Promise<CurrentOrg> {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("Not signed in.");

  const db = createServiceRoleClient();
  const { data: superAdminRow } = await db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (superAdminRow) {
    const impersonatedOrgId = await getImpersonatedOrgId();
    if (impersonatedOrgId) return { userId: user.id, orgId: impersonatedOrgId, email: user.email ?? null };
  }

  const { data: memberships, error } = await supabase.from("org_members").select("org_id").eq("user_id", user.id);
  if (error) throw new Error(error.message);
  if (!memberships || memberships.length === 0) {
    throw new Error("Your account isn't linked to an organization yet — ask your admin to invite you.");
  }

  const cookieOrgId = await getActiveOrgCookie();
  const orgId = resolveActiveOrgId(
    cookieOrgId,
    memberships.map((m) => m.org_id)
  );
  // Unreachable in practice (memberships is non-empty, so resolveActiveOrgId's
  // fallback always returns a real org_id) — satisfies the non-null return type.
  if (!orgId) throw new Error("Your account isn't linked to an organization yet — ask your admin to invite you.");

  return { userId: user.id, orgId, email: user.email ?? null };
}
