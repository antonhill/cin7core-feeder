"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { IMPERSONATED_ORG_COOKIE } from "@/lib/org-switch";

export interface SwitchableOrg {
  id: string;
  name: string;
  logoUrl: string | null;
}

export interface OrgSwitchListResult {
  ok: boolean;
  error?: string;
  orgs?: SwitchableOrg[];
}

/**
 * Every org that exists, for the org-switcher dropdown — super-admin only.
 * Deliberately not filtered by org_members: a super-admin can view any org's
 * data without being an explicit member (Anton: "I should be able to access
 * any organisation as the master user").
 */
export async function listOrgsForSwitcherAction(): Promise<OrgSwitchListResult> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db.from("organizations").select("id, name, logo_url").order("name");
    if (error) throw new Error(error.message);
    return { ok: true, orgs: (data ?? []).map((o) => ({ id: o.id, name: o.name, logoUrl: o.logo_url })) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface SetImpersonatedOrgResult {
  ok: boolean;
  error?: string;
}

/**
 * Sets which org a super-admin is currently viewing as. This cookie is only
 * ever a "which org" hint, never an authorization grant by itself — every
 * actual read/write still re-checks super-admin status server-side (see
 * requireCurrentOrg/getCurrentUserInfo) before honoring it, so a non-super-
 * admin can't gain anything by tampering with this cookie's value.
 */
export async function setImpersonatedOrgAction(orgId: string): Promise<SetImpersonatedOrgResult> {
  try {
    await requireSuperAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db.from("organizations").select("id").eq("id", orgId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, error: "Organization not found." };

    const cookieStore = await cookies();
    cookieStore.set(IMPERSONATED_ORG_COOKIE, orgId, {
      httpOnly: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Plain form action (see AppNav's "Exit" button) — clears impersonation and sends the super-admin back to their own org's home page. */
export async function clearImpersonatedOrgAction() {
  await requireSuperAdmin();
  const cookieStore = await cookies();
  cookieStore.delete(IMPERSONATED_ORG_COOKIE);
  redirect("/");
}
