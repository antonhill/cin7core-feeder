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
}

/** Current user's email, super-admin status, and org branding — used to render the nav. */
export async function getCurrentUserInfo(): Promise<CurrentUserInfo> {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { email: null, isSuperAdmin: false, orgName: null, orgLogoUrl: null };

  const db = createServiceRoleClient();
  const { data: superAdminRow } = await db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();

  // Mirrors requireCurrentOrg's "first membership wins" rule, but non-throwing
  // — the nav renders for super-admins and not-yet-invited users too, who may
  // have no org membership at all.
  const { data: membership } = await db.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
  let orgName: string | null = null;
  let orgLogoUrl: string | null = null;
  if (membership) {
    const { data: org } = await db.from("organizations").select("name, logo_url").eq("id", membership.org_id).maybeSingle();
    orgName = org?.name ?? null;
    orgLogoUrl = org?.logo_url ?? null;
  }

  return { email: user.email ?? null, isSuperAdmin: Boolean(superAdminRow), orgName, orgLogoUrl };
}
