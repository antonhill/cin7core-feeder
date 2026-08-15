import "server-only";
import type { createServiceRoleClient } from "@/supabase/server";

type Db = ReturnType<typeof createServiceRoleClient>;

// A single job chunk (runNextChunk/runNextPullChunk) runs inside a Vercel
// function capped at 300s (see import/layout.tsx and migrate/layout.tsx's
// maxDuration). This TTL only needs to comfortably outlast that hard
// ceiling so a crashed or timed-out chunk's claim is reclaimable, not left
// stuck forever — same reasoning as sync-lock.ts's SYNC_LOCK_TTL_SECONDS.
export const JOB_LOCK_TTL_SECONDS = 6 * 60;

export type JobLockTable = "push_jobs" | "pull_jobs";

export type JobLockResult = { claimed: true; lockedAt: string } | { claimed: false };

/**
 * Try to claim the right to process the next chunk of `jobId` in `table`.
 * Unlike migrations 0055-0057's claim tables, the job row already exists by
 * the time a chunk runs (created by startPushJobAction/startPullJobAction
 * beforehand) — so this is a single atomic conditional UPDATE rather than an
 * insert-or-reclaim function: `locked_at` is only set when it's currently
 * NULL or older than the TTL, and Postgres's own row-level locking on the
 * UPDATE statement is what makes the check-and-set atomic against a
 * concurrent caller doing the exact same UPDATE.
 *
 * On ANY guard error (DB unreachable, migration not applied) this FAILS
 * OPEN (claimed=true), so a chunk still runs exactly as it did before this
 * guard existed — overlapping chunks are only possible during a guard
 * outage, i.e. the same exposure as today.
 */
export async function claimJobLock(db: Db, table: JobLockTable, jobId: string): Promise<JobLockResult> {
  const now = new Date().toISOString();
  const thresholdIso = new Date(Date.now() - JOB_LOCK_TTL_SECONDS * 1000).toISOString();
  const { data, error } = await db
    .from(table)
    .update({ locked_at: now })
    .eq("id", jobId)
    .or(`locked_at.is.null,locked_at.lt.${thresholdIso}`)
    .select("id");
  if (error) {
    console.error(`claimJobLock (${table}) failed; proceeding without the job-chunk guard:`, error.message);
    return { claimed: true, lockedAt: now };
  }
  return (data?.length ?? 0) > 0 ? { claimed: true, lockedAt: now } : { claimed: false };
}

/**
 * Release a held claim (best-effort) — only clears `locked_at` if it still
 * matches what we set, so a chunk that somehow outlived its own TTL (should
 * never happen: Vercel's 300s hard function timeout is well inside the 6 min
 * TTL) can never clear a DIFFERENT chunk's claim reclaimed after ours
 * expired. Same defense-in-depth shape as sync-lock.ts's releaseSyncLock.
 */
export async function releaseJobLock(db: Db, table: JobLockTable, jobId: string, lockedAt: string): Promise<void> {
  const { error } = await db.from(table).update({ locked_at: null }).eq("id", jobId).eq("locked_at", lockedAt);
  if (error) console.error(`releaseJobLock (${table}) failed:`, error.message);
}
