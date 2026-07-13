-- Cron rotation bookkeeping — lets each unscoped Vercel Cron GET handler
-- (/api/sync, /api/sync-sales, /api/sync-purchases,
-- /api/sync-assembly-builds, /api/sync-product-availability) work through
-- every org's active instances a few orgs at a time per 15-minute tick
-- instead of sweeping every org in one maxDuration=300s invocation —
-- confirmed live 2026-07-11 that the sweep-everything-at-once shape hits
-- Vercel's 300s ceiling and returns a hard timeout as the tenant base
-- grows. See src/sync/cron-rotation.ts for the actual rotation logic; this
-- table only records, per (sync_route, org_id), when that org was last
-- attempted, so the next tick can pick up with the stalest org first.
--
-- Pure internal cron bookkeeping — never read by end users or app UI, only
-- written/read by server-side sync code using the service-role client.
-- Stricter than sync_state (0001_canonical_schema.sql), which has an
-- org-member select policy: this table has no legitimate end-user-facing
-- reason to be read at all, so RLS is enabled with NO policies whatsoever
-- (service-role bypasses RLS by default; omitting every policy blocks all
-- non-service-role access, including an org member reading their own row).
create table if not exists sync_route_attempts (
  sync_route        text not null,
  org_id            uuid not null references organizations (id) on delete cascade,
  last_attempted_at timestamptz,
  primary key (sync_route, org_id)
);

-- Drives the "oldest/never-attempted first" ordering in cron-rotation.ts's
-- own query — covers the actual lookup shape (all rows for one
-- sync_route, oldest last_attempted_at first) without over-indexing a
-- small table.
create index if not exists sync_route_attempts_route_idx on sync_route_attempts (sync_route, last_attempted_at);

alter table sync_route_attempts enable row level security;
-- Deliberately no policies — see comment above.
