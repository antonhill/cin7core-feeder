"use server";

import { redirect } from "next/navigation";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { getImpersonatedOrgId } from "@/lib/org-switch";

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
  /** Module hrefs (e.g. "/reports") hidden from this org — set by a super-admin on /admin. Empty means every module is visible. */
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
    const { data: membership } = await db.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
    orgId = membership?.org_id ?? null;
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
    disabledModules = org?.disabled_modules ?? [];
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
    disabledModules,
    subscriptionStatus,
    trialEndsAt,
  };
}
