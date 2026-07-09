import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgPurchases } from "@/sync/sync-purchases";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

// Separate cron/route from /api/sync and /api/sync-sales: purchase receipt
// sync is its own two-phase, queue-based process (see sync/sync-purchases.ts)
// that can take several runs to catch up on a backlog — isolating it means a
// slow purchase backfill can't delay or crowd out the other syncs' own time
// budget, same reasoning as sales.
export const maxDuration = 60;

/** GET — Vercel Cron entry point, same auth convention as /api/sync. */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const results = await syncOrgPurchases(createServiceRoleClient());
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

/** POST { orgId, instanceIds? } — on-demand purchase sync for one org's active instances (or a subset). */
export async function POST(req: Request) {
  try {
    assertInternalAuth(req);
    const body = await req.json().catch(() => ({}));
    const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.filter((i: unknown) => typeof i === "string") : undefined;

    const results = await syncOrgPurchases(createServiceRoleClient(), orgId, instanceIds);
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
