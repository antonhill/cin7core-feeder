import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgProductionRuns } from "@/sync/sync-production-runs";
import { runCronRotation } from "@/sync/cron-rotation";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

// Security re-audit closure, Blocker 6: the on-demand POST handler this
// route used to have was removed entirely (2026-08-18) — it trusted a
// body-supplied orgId behind only the same CRON_SECRET check GET uses,
// letting anyone holding that one shared secret act as service-role
// against ANY org by changing the JSON body (the exact shape round 2
// already deleted /api/import for). Confirmed zero legitimate callers
// existed for any of the 6 sync routes' POST handlers before removal — see
// docs/security-final-closure-matrix.md. GET (the real Vercel Cron entry
// point) is unaffected.

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

