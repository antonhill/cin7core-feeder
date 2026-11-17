"use server";

import { cookies } from "next/headers";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { ACTIVE_ORG_COOKIE } from "@/lib/active-org-resolution";
import { NEWQUIP_POC_ORG_IDS } from "@/newquip/access";
import { NEWQUIP_NO_ACCESS_MESSAGE } from "@/newquip/entry";

/**
 * Called by /newquip/login right after the email code is verified. Decides, server-side, whether this account may use NewQuip:
 * a member of the NewQuip organisation (the active organisation is set to it, so a multi-org user lands in NewQuip) or a super-admin (proceeds; active org untouched unless they are also a member).
 * Anyone else is signed out here and refused with a message that never names another organisation. Not the authorisation boundary for NewQuip data: every route layout and action still authorises on its own.
 * ("use server" file: async function exports only.)
 */
export async function completeNewquipSignInAction(): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = await createSessionClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Not signed in." };

    const db = createServiceRoleClient();
    const [{ data: memberships, error: memberError }, { data: superAdminRow, error: superError }] = await Promise.all([
      db.from("org_members").select("org_id").eq("user_id", user.id),
      db.from("super_admins").select("user_id").eq("user_id", user.id).maybeSingle(),
    ]);
    if (memberError || superError) throw new Error("lookup failed");

    const newquipOrgId = (memberships ?? []).map((m) => m.org_id).find((id) => NEWQUIP_POC_ORG_IDS.includes(id));
    if (newquipOrgId) {
      const cookieStore = await cookies();
      // Same attributes as setActiveOrgAction (src/actions/active-org.ts).
      cookieStore.set(ACTIVE_ORG_COOKIE, newquipOrgId, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
      return { ok: true };
    }
    if (superAdminRow) return { ok: true };

    await supabase.auth.signOut();
    return { ok: false, error: NEWQUIP_NO_ACCESS_MESSAGE };
  } catch {
    return { ok: false, error: "We could not confirm your access. Please try again." };
  }
}
