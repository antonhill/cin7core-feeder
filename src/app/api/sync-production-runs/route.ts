import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgProductionRuns } from "@/sync/sync-production-runs";
import { runCronRotation } from "@/sync/cron-rotation";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

// Two-phase, queue-based process (see sync/sync-production-runs.ts) — same
// isolation reasoning as assembly builds/sales/purchases: a slow backlog
// can't delay or crowd out the other syncs' own time budget.
export const maxDuration = 300;

/**
 * GET — Vercel Cron entry point, same auth convention as every other sync
 * route. Rotates through active orgs oldest-attempted-first (see
 * src/sync/cron-rotation.ts) from day one — this route is new, so unlike
 * the other 5 sync routes it never had the unscoped-sweep bug to begin
 * with.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const db = createServiceRoleClient();
    const results = await runCronRotation(db, "sync-production-runs", (orgId) => syncOrgProductionRuns(db, orgId));
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

/** POST { orgId, instanceIds? } — on-demand production-run sync for one org's active instances (or a subset). */
export async function POST(req: Request) {
  try {
    assertInternalAuth(req);
    const body = await req.json().catch(() => ({}));
    const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.filter((i: unknown) => typeof i === "string") : undefined;

    const results = await syncOrgProductionRuns(createServiceRoleClient(), orgId, instanceIds);
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
