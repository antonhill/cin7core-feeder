import { NextResponse } from "next/server";
import { createServiceRoleClient } from "@/supabase/server";
import { flushPendingShipByNotifications } from "@/lib/ship-by-notifications";
import { assertInternalAuth, UnauthorizedError } from "@/lib/internal-auth";

/**
 * GET — Vercel Cron entry point, same bearer-secret auth convention as
 * every other sync route. Runs every minute (vercel.json) — deliberately
 * NOT scoped per-org like the Cin7 syncs (runSyncRotation), since this does
 * no Cin7 API traffic at all: a plain DB read of whatever's due across every
 * org, plus a handful of Resend calls. A minute's worth of debounce-expired
 * rows is never going to be large enough to need rotation the way a
 * rate-limited Cin7 sweep does.
 */
export async function GET(req: Request) {
  try {
    assertInternalAuth(req);
    const db = createServiceRoleClient();
    const result = await flushPendingShipByNotifications(db);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof UnauthorizedError) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: e instanceof Error ? e.message : "Unknown error" }, { status: 500 });
  }
}
