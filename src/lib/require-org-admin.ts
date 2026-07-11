import { requireCurrentOrg, type CurrentOrg } from "@/lib/current-org";
import { createServiceRoleClient } from "@/supabase/server";

/**
 * Throws unless the current session's user is an owner/admin of their own
 * org (or a super-admin, who always passes — same escape hatch every other
 * org-scoped check in this app already gives them, including while
 * impersonating another org) — the gate for /settings/members and its
 * server actions. requireCurrentOrg() only selects org_id, so this needs
 * its own separate role lookup rather than growing that function's own
 * query — requireCurrentOrg() is a dependency of every mutating action in
 * the app, and this feature's one extra read isn't worth that blast radius.
 */
export async function requireOrgAdmin(): Promise<CurrentOrg> {
  const current = await requireCurrentOrg();

  const db = createServiceRoleClient();
  const { data: superAdminRow } = await db.from("super_admins").select("user_id").eq("user_id", current.userId).maybeSingle();
  if (superAdminRow) return current;

  const { data: membership } = await db
    .from("org_members")
    .select("role")
    .eq("org_id", current.orgId)
    .eq("user_id", current.userId)
    .maybeSingle();
  if (!membership || (membership.role !== "owner" && membership.role !== "admin")) {
    throw new Error("Only an org owner or admin can manage team members.");
  }

  return current;
}
