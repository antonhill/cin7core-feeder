import "server-only";
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;

// A single org's sync (syncOrgInstances → syncInstance) runs inside a Vercel
// function capped at 300s (see src/app/api/sync/route.ts's maxDuration).
// This TTL only needs to comfortably outlast that hard ceiling so a crashed
// or timed-out run's lock is reclaimable, not left stuck forever.
export const SYNC_LOCK_TTL_SECONDS = 6 * 60;

export interface SyncLockAcquireResult {
  /** true → the caller OWNS the lock; it must release it (with THIS exact lockedAt) when done. */
  acquired: boolean;
}

export interface SyncLockHeld {
  acquired: true;
  lockedAt: string;
}

export type SyncLockResult = SyncLockHeld | { acquired: false };

/**
 * Try to acquire the per-(org,instance) sync lock (migration 0057's
 * `try_acquire_sync_lock`). On ANY guard error — DB unreachable, or the
 * migration not applied yet — this FAILS OPEN (acquired=true, no lockedAt to
 * release), so sync still runs exactly as it did before this guard existed.
 * Overlapping syncs are only possible during a guard outage, i.e. the same
 * exposure as today; the guard must never block a sync on its own
 * availability.
 */
export async function acquireSyncLock(db: Db, orgId: string, instanceId: string): Promise<SyncLockResult> {
  const { data, error } = await db.rpc("try_acquire_sync_lock", {
    p_org: orgId,
    p_instance: instanceId,
    p_ttl_seconds: SYNC_LOCK_TTL_SECONDS,
  });
  if (error) {
    console.error("try_acquire_sync_lock failed; proceeding without the sync lock:", error.message);
    return { acquired: true, lockedAt: "" };
  }
  const row = (Array.isArray(data) ? data[0] : data) as { acquired?: boolean; locked_at?: string } | undefined;
  if (!row) return { acquired: true, lockedAt: "" };
  if (!row.acquired) return { acquired: false };
  return { acquired: true, lockedAt: row.locked_at ?? "" };
}

/**
 * Release a held lock (best-effort) — only clears the row if `lockedAt`
 * still matches what we acquired, so a lock this run held past its TTL and
 * that another run has since reclaimed is never cleared out from under that
 * new holder.
 */
export async function releaseSyncLock(db: Db, orgId: string, instanceId: string, lockedAt: string): Promise<void> {
  if (!lockedAt) return; // Nothing to release — the guard failed open (see acquireSyncLock).
  const { error } = await db.from("sync_locks").delete().eq("org_id", orgId).eq("instance_id", instanceId).eq("locked_at", lockedAt);
  if (error) console.error("releaseSyncLock failed:", error.message);
}
