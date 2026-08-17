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
 * `try_acquire_sync_lock`). Security re-audit round 3, P1-5 (Anton-approved
 * 2026-08-17): FAILS CLOSED on any guard error — DB unreachable, or the
 * migration not applied — by THROWING, rather than proceeding as if the lock
 * were acquired. This is the real backstop against a genuine duplicate
 * product/customer/supplier record in Cin7 (two overlapping syncs both
 * missing a find-by-SKU/Name check during a guard outage) — see
 * docs/security-reaudit-report-2026-08-17.md's round 3 P1-5 section for the
 * decision table this was approved against. The caller (sync-org.ts) treats
 * this the same as any other per-instance sync failure: that one instance's
 * sync fails for this run, other instances proceed unaffected. (Previously
 * failed open, returning acquired=true.)
 */
export async function acquireSyncLock(db: Db, orgId: string, instanceId: string): Promise<SyncLockResult> {
  const { data, error } = await db.rpc("try_acquire_sync_lock", {
    p_org: orgId,
    p_instance: instanceId,
    p_ttl_seconds: SYNC_LOCK_TTL_SECONDS,
  });
  if (error) {
    throw new Error(`try_acquire_sync_lock failed (sync lock guard unavailable): ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as { acquired?: boolean; locked_at?: string } | undefined;
  if (!row) throw new Error("try_acquire_sync_lock returned no row (sync lock guard unavailable)");
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
