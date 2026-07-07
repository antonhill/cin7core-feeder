"use server";

import { redirect } from "next/navigation";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";

export async function signOutAction() {
  const supabase = await createSessionClient();
  await supabase.auth.signOut();
  redirect("/login");
}

export interface CurrentUserInfo {
  email: string | null;
  isSuperAdmin: boolean;
  orgName: string | null;
  orgLogoUrl: string | null;
  /** Module hrefs (e.g. "/reports") hidden from this org — set by a super-admin on /admin. Empty means every module is visible. */
  disabledModules: string[];
}

/** Current user's email, super-admin status, org branding, and enabled modules — used to render the nav/home tiles. */
export async function getCurrentUserInfo(): Promise<CurrentUserInfo> {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { email: null, isSuperAdmin: false, orgName: null, orgLogoUrl: null, disabledModules: [] };

  const db = createServiceRoleClient();
  const { data: superAdminRow } = await db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();

  // Mirrors requireCurrentOrg's "first membership wins" rule, but non-throwing
  // — the nav renders for super-admins and not-yet-invited users too, who may
  // have no org membership at all.
  const { data: membership } = await db.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
  let orgName: string | null = null;
  let orgLogoUrl: string | null = null;
  let disabledModules: string[] = [];
  if (membership) {
    const { data: org } = await db.from("organizations").select("name, logo_url, disabled_modules").eq("id", membership.org_id).maybeSingle();
    orgName = org?.name ?? null;
    orgLogoUrl = org?.logo_url ?? null;
    disabledModules = org?.disabled_modules ?? [];
  }

  return { email: user.email ?? null, isSuperAdmin: Boolean(superAdminRow), orgName, orgLogoUrl, disabledModules };
}
