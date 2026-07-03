import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncInstance } from "@/sync/run-sync";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

// Cin7's own limit is 60 calls/min; a catalogue with real volume can take
// well over the default function timeout to sync at 1 req/sec.
export const maxDuration = 60;

async function syncAllActiveInstances(orgId?: string) {
  const db = createServiceRoleClient();

  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);

  const results = [];
  for (const instance of instances ?? []) {
    try {
      const summary = await syncInstance(db, instance.org_id, instance.id);
      results.push({ ok: true, ...summary });
    } catch (e) {
      results.push({
        ok: false,
        instanceId: instance.id,
        orgId: instance.org_id,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
  return results;
}

/**
 * GET — the Vercel Cron entry point (crons always call GET and Vercel
 * auto-injects `Authorization: Bearer <CRON_SECRET>`; set CRON_SECRET in
 * Vercel to the same value as SYNC_SHARED_SECRET so this passes auth).
 * Syncs every active instance across every organization.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const results = await syncAllActiveInstances();
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

/** POST { orgId } — on-demand sync for one organization's active instances. */
export async function POST(req: Request) {
  try {
    assertInternalAuth(req);
    const body = await req.json().catch(() => ({}));
    const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });

    const results = await syncAllActiveInstances(orgId);
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
