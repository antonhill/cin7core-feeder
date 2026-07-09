import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";
import { deleteOrganizationById } from "@/lib/delete-organization";
import { TRIAL_DELETION_GRACE_DAYS } from "@/lib/trial-expiry";

/**
 * Daily cron — permanently deletes any org still on a trial
 * TRIAL_DELETION_GRACE_DAYS after its trial_ends_at date. Gated on
 * subscription_status = "trialing" specifically (not just the date), so an
 * org that ever converted to active/past_due/canceled is never touched by
 * this, regardless of how old trial_ends_at is — see trial-expiry.ts.
 *
 * Confirmed live 2026-07-09 against the real orgs table before this shipped:
 * no org would have been caught on first deploy (the two real working orgs
 * were already "active"; the two trialing test orgs' trial_ends_at was
 * still in the future).
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const db = createServiceRoleClient();

    const cutoff = new Date(Date.now() - TRIAL_DELETION_GRACE_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const { data: expired, error } = await db
      .from("organizations")
      .select("id, name, trial_ends_at")
      .eq("subscription_status", "trialing")
      .lt("trial_ends_at", cutoff);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const results = [];
    for (const org of expired ?? []) {
      const result = await deleteOrganizationById(db, org.id);
      results.push({ orgId: org.id, name: org.name, trialEndsAt: org.trial_ends_at, ...result });
    }

    return NextResponse.json({ deletedCount: results.filter((r) => r.ok).length, results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
