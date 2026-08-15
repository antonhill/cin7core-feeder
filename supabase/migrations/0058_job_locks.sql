-- Phase 4.4: job-chunk claim for push_jobs / pull_jobs.
--
-- continuePushJobAction/continuePullJobAction each read the job row (status,
-- prior outcomes/results), run the next budgeted chunk (which can itself
-- take up to ~260s — real Cin7 API calls), then write the merged result
-- back — a plain read-then-write with no claim in between. Two concurrent
-- calls for the SAME jobId (realistic case: two browser tabs/windows open to
-- the same org's /import or /migrate, both finding the same org-wide
-- "current running job" on mount and both driving it — see
-- usePushJob.ts/usePullJob.ts's mount-effect "resume" path) both read the
-- same prior state, both do the real work again (Phase 4.3's sync lock stops
-- the underlying Cin7 writes from actually duplicating, but the job row
-- itself still races), and whichever UPDATE lands last silently overwrites
-- the other's result — a lost update, not just wasted work.
--
-- Unlike migrations 0055-0057, this needs no new claim table or PL/pgSQL
-- function: the job row already exists by the time a chunk runs (created by
-- startPushJobAction/startPullJobAction beforehand), so the "claiming
-- UPDATE" is just a single atomic conditional UPDATE issued directly via the
-- Supabase client — `UPDATE ... SET locked_at = now() WHERE id = $jobId AND
-- (locked_at IS NULL OR locked_at < now() - ttl) RETURNING id` — Postgres's
-- own row-level locking on that UPDATE statement is what makes it atomic
-- (src/lib/job-lock.ts).
--
-- Note: push_jobs itself has no earlier migration file in this repo (shipped
-- 2026-07-19, applied directly to the live DB — see 0047_pull_jobs.sql's own
-- note about this gap). This migration only adds a column to it, so it's
-- safe regardless of that gap.

alter table push_jobs add column if not exists locked_at timestamptz;
alter table pull_jobs add column if not exists locked_at timestamptz;

comment on column push_jobs.locked_at is
  'Phase 4.4 job-chunk claim — set by a claiming UPDATE while a chunk is being processed, cleared on release. Stale-TTL-reclaimable (src/lib/job-lock.ts).';
comment on column pull_jobs.locked_at is
  'Phase 4.4 job-chunk claim — set by a claiming UPDATE while a chunk is being processed, cleared on release. Stale-TTL-reclaimable (src/lib/job-lock.ts).';
