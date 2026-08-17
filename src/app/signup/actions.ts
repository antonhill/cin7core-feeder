"use server";

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

    // Re-visiting /signup after already converting shouldn't create a second
    // org — treat it as success (not a redirect() call: that throws
    // internally and this whole block is wrapped in a try/catch below, which
    // would silently swallow it as a generic error instead of navigating).
    // The caller (signup/page.tsx) redirects home on any ok:true result.
    const { data: existingMembership } = await db.from("org_members").select("org_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (existingMembership) return { ok: true };

    // Security re-audit P1-8: org + owner-membership creation via one atomic
    // RPC (migration 0076) — the previous two-separate-inserts shape could
    // leave an orphaned, ownerless org behind if the second insert failed.
    const { error: createError } = await db.rpc("create_self_serve_org", {
      p_org_name: orgName.trim(),
      p_user_id: user.id,
    });
    if (createError) return { ok: false, error: createError.message };

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
