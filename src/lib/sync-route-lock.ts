import "server-only";
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;

// A single org's sync run for one route is bounded by the same 300s Vercel
// hard timeout every sync route's maxDuration sets — this TTL only needs to
// comfortably outlast that ceiling, same reasoning as sync-lock.ts's
// SYNC_LOCK_TTL_SECONDS (which this mirrors at a coarser org+route grain
// rather than org+instance).
export const SYNC_ROUTE_LOCK_TTL_SECONDS = 6 * 60;

export type SyncRouteLockResult = { acquired: true; lockedAt: string } | { acquired: false };

/**
 * Try to acquire the per-(org,route) sync advisory lock (migration 0059's
 * `try_acquire_sync_route_lock`) — stops the SAME org's sync for a given
 * route (e.g. "sync-sales") from being scanned twice concurrently by an
 * overlapping cron tick, on-demand POST, and/or a report page's own "sync
 * now" action. On ANY guard error (DB unreachable, migration not applied)
 * this FAILS OPEN (acquired=true, no lockedAt to release), so a sync still
 * runs exactly as it did before this guard existed.
 */
export async function acquireSyncRouteLock(db: Db, syncRoute: string, orgId: string): Promise<SyncRouteLockResult> {
  const { data, error } = await db.rpc("try_acquire_sync_route_lock", {
    p_route: syncRoute,
    p_org: orgId,
    p_ttl_seconds: SYNC_ROUTE_LOCK_TTL_SECONDS,
  });
  if (error) {
    console.error(`try_acquire_sync_route_lock (${syncRoute}) failed; proceeding without the route lock:`, error.message);
    return { acquired: true, lockedAt: "" };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { acquired?: boolean; locked_at?: string } | undefined;
  if (!row) return { acquired: true, lockedAt: "" };
  if (!row.acquired) return { acquired: false };
  return { acquired: true, lockedAt: row.locked_at ?? "" };
}

/**
 * Release a held lock (best-effort) — only clears the row if `lockedAt`
 * still matches what we acquired, so a run that somehow outlived its own
 * TTL can never clear a DIFFERENT run's lock reclaimed after ours expired.
 * Same defense-in-depth shape as sync-lock.ts's releaseSyncLock.
 */
export async function releaseSyncRouteLock(db: Db, syncRoute: string, orgId: string, lockedAt: string): Promise<void> {
  if (!lockedAt) return; // Nothing to release — the guard failed open (see acquireSyncRouteLock).
  const { error } = await db.from("sync_route_locks").delete().eq("sync_route", syncRoute).eq("org_id", orgId).eq("locked_at", lockedAt);
  if (error) console.error(`releaseSyncRouteLock (${syncRoute}) failed:`, error.message);
}
