"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireSuperAdmin } from "@/lib/require-super-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { IMPERSONATED_ORG_COOKIE } from "@/lib/org-switch";

// Impersonation is an active, deliberate support task — the "which org" cookie
// shouldn't outlive a work session. 8 hours (down from 30 days), so an
// impersonation left open by accident reverts on its own the same day.
const IMPERSONATION_MAX_AGE_SECONDS = 60 * 60 * 8;

/**
 * Structured server-side audit line for impersonation start/end. Written to the
 * platform logs (Vercel) rather than a client-visible `activity_log` row, so a
 * super-admin's access to an org isn't surfaced in that org's own Activity feed.
 * A durable, queryable super-admin audit table is Phase 13 (observability) work;
 * this is the immediate, no-schema-change audit trail the hardening brief asks for.
 */
function logImpersonationEvent(
  event: "start" | "end",
  info: { actorUserId: string; targetOrgId: string | null; targetOrgName?: string | null }
): void {
  console.info(`[impersonation.${event}] ${JSON.stringify({ at: new Date().toISOString(), ...info })}`);
}

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
    const { userId } = await requireSuperAdmin();
    const db = createServiceRoleClient();
    const { data, error } = await db.from("organizations").select("id, name").eq("id", orgId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) return { ok: false, error: "Organization not found." };

    const cookieStore = await cookies();
    cookieStore.set(IMPERSONATED_ORG_COOKIE, orgId, {
      httpOnly: true,
      // Only sent over HTTPS in production; local dev is plain http.
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: IMPERSONATION_MAX_AGE_SECONDS,
    });
    logImpersonationEvent("start", { actorUserId: userId, targetOrgId: data.id, targetOrgName: data.name });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Plain form action (see AppNav's "Exit" button) — clears impersonation and sends the super-admin back to their own org's home page. */
export async function clearImpersonatedOrgAction() {
  const { userId } = await requireSuperAdmin();
  const cookieStore = await cookies();
  // Capture which org was being viewed BEFORE deleting the cookie, for the audit line.
  const previousOrgId = cookieStore.get(IMPERSONATED_ORG_COOKIE)?.value ?? null;
  cookieStore.delete(IMPERSONATED_ORG_COOKIE);
  logImpersonationEvent("end", { actorUserId: userId, targetOrgId: previousOrgId });
  redirect("/");
}
