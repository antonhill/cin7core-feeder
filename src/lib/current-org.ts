import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { getImpersonatedOrgId } from "@/lib/org-switch";

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
 * If a user belongs to more than one org, the first membership is used.
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

  const { data: membership, error } = await supabase
    .from("org_members")
    .select("org_id")
    .eq("user_id", user.id)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!membership) throw new Error("Your account isn't linked to an organization yet — ask your admin to invite you.");

  return { userId: user.id, orgId: membership.org_id, email: user.email ?? null };
}
