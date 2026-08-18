import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgSales } from "@/sync/sync-sales";
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

// Separate cron/route from /api/sync: sales sync is a two-phase, queue-based
// process (see sync/sync-sales.ts) that can take several runs to catch up on
// a backlog, rather than always finishing the whole org catalog in one pass
// — isolating it means a slow sales backfill can't delay or crowd out the
// product/customer/supplier sync's own time budget. 300s (not 60s) — bumped
// 2026-07-09 after a real FUNCTION_INVOCATION_TIMEOUT on a full-scope
// backfill (sync-sales.ts now fetches every sale, not just invoiced ones,
// for the Order Fulfillment Dashboard), same fix every other sync route
// already needed (/api/sync, /api/sync-purchases).
export const maxDuration = 300;

/**
 * GET — Vercel Cron entry point, same auth convention as /api/sync.
 * Rotates through active orgs oldest-attempted-first (see
 * src/sync/cron-rotation.ts) rather than sweeping every org's sales in one
 * invocation — confirmed live 2026-07-11 that the unscoped sweep can hit
 * the 300s ceiling as the tenant base grows, same bug /api/sync had.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const db = createServiceRoleClient();
    const results = await runCronRotation(db, "sync-sales", (orgId) => syncOrgSales(db, orgId));
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

