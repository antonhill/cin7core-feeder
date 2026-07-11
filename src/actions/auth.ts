"use server";

import { redirect } from "next/navigation";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { getImpersonatedOrgId } from "@/lib/org-switch";
import { computeEffectiveDisabledModules } from "@/app/module-nav";

export async function signOutAction() {
  const supabase = await createSessionClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export interface CurrentUserInfo {
  email: string | null;
  isSuperAdmin: boolean;
  orgId: string | null;
  orgName: string | null;
  orgLogoUrl: string | null;
  /** True when a super-admin is currently viewing as an org other than one they're a real member of — drives the persistent "Viewing as" banner. */
  isImpersonating: boolean;
  /** True for a super-admin, or an org_members row with role 'owner'/'admin' — drives visibility of the Team settings icon and gates /settings/members server-side via requireOrgAdmin(). */
  isOrgAdmin: boolean;
  /** Module hrefs (e.g. "/reports") hidden from THIS USER — the org-wide gate (set by a super-admin on /admin) merged with this user's own allow-list (set by their org's owner/admin on /settings/members, see computeEffectiveDisabledModules). Empty means every module is visible to them. */
  disabledModules: string[];
  /** Drives the trial banner in layout.tsx — kept as plain scalars rather than a nested BillingStatus object to minimize churn on this widely-called function. */
  subscriptionStatus: "trialing" | "active" | "past_due" | "canceled" | null;
  trialEndsAt: string | null;
}

/** Current user's email, super-admin status, org branding, and enabled modules — used to render the nav/home tiles. */
export async function getCurrentUserInfo(): Promise<CurrentUserInfo> {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return {
      email: null,
      isSuperAdmin: false,
      orgId: null,
      orgName: null,
      orgLogoUrl: null,
      isImpersonating: false,
      isOrgAdmin: false,
      disabledModules: [],
      subscriptionStatus: null,
      trialEndsAt: null,
    };
  }

  const db = createServiceRoleClient();
  const { data: superAdminRow } = await db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  const isSuperAdmin = Boolean(superAdminRow);

  let orgId: string | null = null;
  let isImpersonating = false;
  // Impersonating super-admins have no org_members row for the impersonated
  // org (that's the whole point of the escape hatch) — allowedModules stays
  // null (unrestricted) and isOrgAdmin stays true for them below, same as
  // every other org-scoped check in this app bypasses membership for them.
  let allowedModules: string[] | null = null;
  let isOrgAdmin = isSuperAdmin;
  if (isSuperAdmin) {
    const impersonatedOrgId = await getImpersonatedOrgId();
    if (impersonatedOrgId) {
      orgId = impersonatedOrgId;
      isImpersonating = true;
    }
  }

  // Mirrors requireCurrentOrg's "first membership wins" rule, but non-throwing
  // — the nav renders for super-admins and not-yet-invited users too, who may
  // have no org membership at all.
  if (!orgId) {
    const { data: membership } = await db
      .from("org_members")
      .select("org_id, role, allowed_modules")
      .eq("user_id", user.id)
      .limit(1)
      .maybeSingle();
    orgId = membership?.org_id ?? null;
    allowedModules = membership?.allowed_modules ?? null;
    // Don't let a super-admin's own (possibly nonexistent) org_members row
    // downgrade isOrgAdmin — a super-admin not currently impersonating any
    // org (e.g. Anton's own account, with no membership row at all) must
    // stay true here, same as the impersonating branch above already does.
    if (!isSuperAdmin) isOrgAdmin = membership?.role === "owner" || membership?.role === "admin";
  }

  let orgName: string | null = null;
  let orgLogoUrl: string | null = null;
  let disabledModules: string[] = [];
  let subscriptionStatus: CurrentUserInfo["subscriptionStatus"] = null;
  let trialEndsAt: string | null = null;
  if (orgId) {
    const { data: org } = await db
      .from("organizations")
      .select("name, logo_url, disabled_modules, subscription_status, trial_ends_at")
      .eq("id", orgId)
      .maybeSingle();
    orgName = org?.name ?? null;
    orgLogoUrl = org?.logo_url ?? null;
    disabledModules = computeEffectiveDisabledModules(org?.disabled_modules ?? [], allowedModules);
    subscriptionStatus = org?.subscription_status ?? null;
    trialEndsAt = org?.trial_ends_at ?? null;
  }

  return {
    email: user.email ?? null,
    isSuperAdmin,
    orgId,
    orgName,
    orgLogoUrl,
    isImpersonating,
    isOrgAdmin,
    disabledModules,
    subscriptionStatus,
    trialEndsAt,
  };
}
