"use server";

import { cookies } from "next/headers";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";
import { ACTIVE_ORG_COOKIE } from "@/lib/active-org";

/**
 * Security re-audit P1-8: explicit active-org selection for a member of more
 * than one org — distinct from org-switch.ts's super-admin impersonation
 * (which can view ANY org). This only ever lists/selects among the caller's
 * OWN real org_members rows, verified server-side on every set.
 */

export interface MyOrg {
  id: string;
  name: string;
}

export interface ListMyOrgsResult {
  ok: boolean;
  error?: string;
  orgs?: MyOrg[];
}

/** Every org the current user is actually a member of, for the active-org switcher. */
export async function listMyOrgsAction(): Promise<ListMyOrgsResult> {
  try {
    const supabase = await createSessionClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Not signed in." };

    const db = createServiceRoleClient();
    const { data: memberships, error: membershipError } = await db.from("org_members").select("org_id").eq("user_id", user.id);
    if (membershipError) throw new Error(membershipError.message);
    const orgIds = (memberships ?? []).map((m) => m.org_id);
    if (orgIds.length === 0) return { ok: true, orgs: [] };

    const { data: orgs, error: orgsError } = await db.from("organizations").select("id, name").in("id", orgIds).order("name");
    if (orgsError) throw new Error(orgsError.message);

    return { ok: true, orgs: orgs ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface SetActiveOrgResult {
  ok: boolean;
  error?: string;
}

/**
 * Sets which org a multi-org member is currently acting as. Verifies real
 * membership server-side before setting the cookie — tampering with the
 * cookie value alone can't grant access to an org the caller isn't actually
 * a member of, since requireCurrentOrg/getCurrentUserInfo both re-check the
 * cookie against real org_members rows on every read (see
 * resolveActiveOrgId in src/lib/active-org.ts).
 */
export async function setActiveOrgAction(orgId: string): Promise<SetActiveOrgResult> {
  try {
    const supabase = await createSessionClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: "Not signed in." };

    const db = createServiceRoleClient();
    const { data: membership, error } = await db
      .from("org_members")
      .select("org_id")
      .eq("org_id", orgId)
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!membership) return { ok: false, error: "You're not a member of that organization." };

    const cookieStore = await cookies();
    cookieStore.set(ACTIVE_ORG_COOKIE, orgId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      // No maxAge — persists for the browser session's own lifetime (a
      // regular member's active-org choice isn't a time-boxed support task
      // the way super-admin impersonation is, so it shouldn't silently
      // revert after a few hours the way IMPERSONATION_MAX_AGE_SECONDS does).
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
