import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgSales } from "@/sync/sync-sales";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

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

/** GET — Vercel Cron entry point, same auth convention as /api/sync. */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const results = await syncOrgSales(createServiceRoleClient());
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

/** POST { orgId, instanceIds? } — on-demand sales sync for one org's active instances (or a subset). */
export async function POST(req: Request) {
  try {
    assertInternalAuth(req);
    const body = await req.json().catch(() => ({}));
    const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.filter((i: unknown) => typeof i === "string") : undefined;

    const results = await syncOrgSales(createServiceRoleClient(), orgId, instanceIds);
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
