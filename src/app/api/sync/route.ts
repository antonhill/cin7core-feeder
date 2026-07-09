import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { syncOrgInstances } from "@/sync/sync-org";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

// Cin7's own limit is 60 calls/min; a catalogue with real volume can take
// well over the default function timeout to sync at 1 req/sec. Confirmed
// live 2026-07-09 (Vercel logs) that the previous 60s cap was too low —
// every org/instance syncs in one unscoped pass here, so 300s (Vercel Pro's
// serverless function ceiling) buys real headroom. If data volume grows
// enough that even this isn't sufficient, the durable fix is scoping this
// to one org per invocation rather than raising the ceiling further.
export const maxDuration = 300;

/**
 * GET — the Vercel Cron entry point (crons always call GET and Vercel
 * auto-injects `Authorization: Bearer <CRON_SECRET>`; set CRON_SECRET in
 * Vercel to the same value as SYNC_SHARED_SECRET so this passes auth).
 * Syncs every active instance across every organization.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const results = await syncOrgInstances(createServiceRoleClient());
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
