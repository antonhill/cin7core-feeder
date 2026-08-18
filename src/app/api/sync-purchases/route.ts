import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgPurchases } from "@/sync/sync-purchases";
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

// Separate cron/route from /api/sync and /api/sync-sales: purchase receipt
// sync is its own two-phase, queue-based process (see sync/sync-purchases.ts)
// that can take several runs to catch up on a backlog — isolating it means a
// slow purchase backfill can't delay or crowd out the other syncs' own time
// budget, same reasoning as sales. Confirmed live 2026-07-09 (same as
// /api/sync) that 60s isn't enough — a first-run backfill detail-fetches up
// to DETAIL_FETCH_BATCH_SIZE purchases, each needing 1-2 rate-limited Cin7
// calls (Advanced-purchase orders need a second call for the fallback), so
// 300s (Vercel Pro's serverless ceiling) buys real headroom.
export const maxDuration = 300;

/**
 * GET — Vercel Cron entry point, same auth convention as /api/sync.
 * Rotates through active orgs oldest-attempted-first (see
 * src/sync/cron-rotation.ts) rather than sweeping every org's purchases in
 * one invocation — same 300s-ceiling bug /api/sync had, confirmed live
 * 2026-07-11 as the tenant base grows.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const db = createServiceRoleClient();
    const results = await runCronRotation(db, "sync-purchases", (orgId) => syncOrgPurchases(db, orgId));
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

