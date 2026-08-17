import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { writeAllowedFor } from "@/lib/billing-status";
import type { CurrentOrg } from "@/lib/current-org";

/**
 * Security re-audit round 3, item 1 (P1-2): action-level AAL2 (two-factor)
 * enforcement. Middleware's own MFA-enrolment gate (src/middleware.ts) only
 * ever protects PAGE NAVIGATION — a direct POST to a Server Action's own
 * endpoint (the client bundle ships a callable reference to every action,
 * independent of whether the user ever rendered the page that would trigger
 * middleware's redirect) never passes through it. This checks the CURRENT
 * session's actual assurance level, not whether a factor is merely enrolled
 * — a user who enrolled a factor but hasn't stepped up THIS session
 * (currentLevel aal1, nextLevel aal2) must still be blocked here, exactly
 * as middleware's own /mfa-challenge redirect would have forced before
 * reaching this action via the normal page flow.
 */
async function requireAal2(action: string): Promise<void> {
  const supabase = await createSessionClient();
  const { data: aal, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error) throw new Error(`Could not verify two-factor authentication status: ${error.message}`);
  if (aal?.currentLevel !== "aal2") {
    throw new Error(`Two-factor authentication is required to ${action}. Verify or enrol at Settings › Security.`);
  }
}

/**
 * Composes requireOrgAdmin's existing role check with the AAL2 check above
 * — for org-admin-gated actions the brief names as high-impact enough to
 * need two-factor confirmation (Cin7 instance/credential management,
 * billing, member invite/removal/role changes).
 *
 * Mirrors middleware.ts's OWN "isPrivileged" condition exactly, not a
 * stricter one: a super-admin always needs AAL2 (regardless of org
 * billing), but an ordinary org owner/admin only does once their org has
 * write access (an active/paid plan) — a read-only TRIAL org's admin is
 * deliberately exempt, matching middleware's Phase 1.5 enrolment-forcing
 * logic ("so trial onboarding isn't gated on setting up an authenticator
 * app first"). Enforcing AAL2 unconditionally here would silently
 * contradict that: middleware would let a trial admin reach a page with no
 * MFA prompt, then this guard would reject the very Server Action that page
 * calls on load — the two checks disagreeing is exactly the class of bug
 * this item exists to close, just in the opposite direction.
 */
export async function requirePrivilegedOrgAdmin(action = "perform this privileged action"): Promise<CurrentOrg> {
  const current = await requireOrgAdmin(action);

  const db = createServiceRoleClient();
  const [{ data: superAdminRow }, { data: orgRow }] = await Promise.all([
    db.from("super_admins").select("user_id").eq("user_id", current.userId).maybeSingle(),
    db.from("organizations").select("subscription_status").eq("id", current.orgId).maybeSingle(),
  ]);
  const isSuperAdmin = Boolean(superAdminRow);
  const orgCanWrite = orgRow ? writeAllowedFor(orgRow.subscription_status) : false;

  if (isSuperAdmin || orgCanWrite) await requireAal2(action);
  return current;
}

/**
 * Composes requireSuperAdmin's existing role check with the AAL2 check above
 * — for super-admin-only actions the brief names as high-impact (organization
 * deletion, superadmin impersonation start, other admin operations in
 * src/app/admin/actions.ts).
 */
export async function requirePrivilegedSuperAdmin(action = "perform this privileged action"): Promise<{ userId: string }> {
  const current = await requireSuperAdmin();
  await requireAal2(action);
  return current;
}
