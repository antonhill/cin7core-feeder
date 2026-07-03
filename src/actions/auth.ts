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
}

/** Current user's email + super-admin status, or nulls if not logged in — used to render the nav. */
export async function getCurrentUserInfo(): Promise<CurrentUserInfo> {
  const supabase = await createSessionClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { email: null, isSuperAdmin: false };

  const db = createServiceRoleClient();
  const { data } = await db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  return { email: user.email ?? null, isSuperAdmin: Boolean(data) };
}
