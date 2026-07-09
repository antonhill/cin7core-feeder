import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgProductAvailability } from "@/sync/sync-product-availability";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

// Same isolation reasoning as the other per-feature syncs: a slow/large
// account's stock-level snapshot pull can't delay or crowd out the other
// syncs' own time budget. 300s (not 60s) from the start, learning from
// sales/purchases/assembly-builds all needing that bump after real timeouts.
export const maxDuration = 300;

/** GET — Vercel Cron entry point, same auth convention as every other sync route. */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const results = await syncOrgProductAvailability(createServiceRoleClient());
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

/** POST { orgId, instanceIds? } — on-demand stock-level sync for one org's active instances (or a subset). */
export async function POST(req: Request) {
  try {
    assertInternalAuth(req);
    const body = await req.json().catch(() => ({}));
    const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.filter((i: unknown) => typeof i === "string") : undefined;

    const results = await syncOrgProductAvailability(createServiceRoleClient(), orgId, instanceIds);
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
