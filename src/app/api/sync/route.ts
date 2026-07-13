import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgInstances } from "@/sync/sync-org";
import { runCronRotation } from "@/sync/cron-rotation";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

// Cin7's own limit is 60 calls/min; a catalogue with real volume can take
// well over the default function timeout to sync at 1 req/sec. Confirmed
// live 2026-07-09 (Vercel logs) that the previous 60s cap was too low, and
// confirmed live again 2026-07-11 that even 300s isn't enough once every
// org/instance is swept in one unscoped invocation. The durable fix (now
// landed): GET rotates through active orgs oldest-attempted-first within a
// time budget per tick, via runCronRotation (src/sync/cron-rotation.ts),
// rather than sweeping every org in one call — 300s is now the safety
// margin for however many orgs the rotation actually attempts per tick,
// not a budget for the whole tenant base at once.
export const maxDuration = 300;

/**
 * GET — the Vercel Cron entry point (crons always call GET and Vercel
 * auto-injects `Authorization: Bearer <CRON_SECRET>`; set CRON_SECRET in
 * Vercel to the same value as SYNC_SHARED_SECRET so this passes auth).
 * Rotates through active orgs oldest-attempted-first (see cron-rotation.ts)
 * rather than sweeping every org in one invocation.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const db = createServiceRoleClient();
    const results = await runCronRotation(db, "sync", (orgId) => syncOrgInstances(db, orgId));
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}

/** POST { orgId, instanceIds? } — on-demand sync for one org's active instances (or a subset). */
export async function POST(req: Request) {
  try {
    assertInternalAuth(req);
    const body = await req.json().catch(() => ({}));
    const orgId = typeof body.orgId === "string" ? body.orgId : undefined;
    if (!orgId) return NextResponse.json({ error: "orgId is required" }, { status: 400 });
    const instanceIds = Array.isArray(body.instanceIds) ? body.instanceIds.filter((i: unknown) => typeof i === "string") : undefined;

    const results = await syncOrgInstances(createServiceRoleClient(), orgId, instanceIds);
    return NextResponse.json({ results });
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
