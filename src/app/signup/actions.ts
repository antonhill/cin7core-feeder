"use server";

import { redirect } from "next/navigation";
import { createSessionClient } from "@/supabase/server-session";
import { createServiceRoleClient } from "@/supabase/server";

export interface CreateSelfServeOrgResult {
  ok: boolean;
  error?: string;
}

/**
 * Self-serve org creation for the new 7-day-trial signup flow — distinct
 * from admin/actions.ts's createOrgAndInvite, which is super-admin-gated and
 * invites *someone else*. This is self-initiated by an already-OTP-verified
 * user creating their own org, called only after verifyOtp succeeds
 * client-side (see signup/page.tsx) — never before, since creating the org
 * first would let an unverified email start a real trial clock for free.
 *
 * The new org gets the schema defaults from migration 0023: subscription_status
 * 'trialing', a 7-day trial_ends_at, max_instances 1 — no need to set them here.
 */
export async function createSelfServeOrgAction(orgName: string): Promise<CreateSelfServeOrgResult> {
  if (!orgName.trim()) return { ok: false, error: "Organization name is required." };

  try {
    const sessionClient = await createSessionClient();
    const {
      data: { user },
    } = await sessionClient.auth.getUser();
    if (!user) return { ok: false, error: "Not signed in." };

    const db = createServiceRoleClient();

    // Re-visiting /signup after already converting shouldn't create a second org.
    const { data: existingMembership } = await db.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (existingMembership) {
      redirect("/");
    }

    const { data: org, error: orgError } = await db.from("organizations").insert({ name: orgName.trim() }).select("id").single();
    if (orgError) return { ok: false, error: orgError.message };

    const { error: memberError } = await db.from("org_members").insert({ org_id: org.id, user_id: user.id, role: "owner" });
    if (memberError) return { ok: false, error: memberError.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
