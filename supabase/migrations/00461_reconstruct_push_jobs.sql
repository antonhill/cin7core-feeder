-- Security re-audit P0-6: push_jobs (the resumable background job behind
-- Import's "Push to Cin7" step) was applied directly to production on
-- 2026-07-19 and its creation migration was never committed — 0047's own
-- comment already flags this ("push_jobs itself has no migration file in
-- this repo... this migration exists so pull_jobs doesn't repeat that
-- gap"), and 0058_job_locks.sql's `alter table push_jobs add column if
-- not exists locked_at` silently assumes the table already exists — which
-- means migrations 0001-current cannot run end-to-end against a blank
-- Supabase project. This migration reconstructs push_jobs exactly as it
-- exists live today (confirmed 2026-08-17 via information_schema,
-- pg_constraint, pg_indexes, pg_policy against production), mirroring
-- pull_jobs' (0047) own shape since that migration was written to match
-- push_jobs' live design. Guarded so it's also a genuine no-op if ever run
-- against production itself: `create table if not exists` covers the
-- table, and CREATE TYPE has no IF NOT EXISTS in Postgres so the enum is
-- guarded with an existence check instead.
do $$ begin
  if not exists (select 1 from pg_type where typname = 'push_job_status') then
    create type push_job_status as enum ('running', 'done', 'failed');
  end if;
end $$;

create table if not exists push_jobs (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations (id) on delete cascade,
  instance_ids uuid[] not null,
  scope        jsonb not null,
  status       push_job_status not null default 'running',
  outcomes     jsonb not null default '[]'::jsonb,
  created_by   uuid references auth.users (id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists push_jobs_org_id_idx on push_jobs (org_id);

alter table push_jobs enable row level security;

-- Confirmed live: the real authorization boundary is requireCurrentOrg() /
-- requireModuleAccess() in the server actions (src/app/import/actions.ts),
-- RLS is defense in depth — same reasoning pull_jobs' own policy comment
-- (0047) gives for its identical shape.
drop policy if exists "org members manage push_jobs" on push_jobs;
create policy "org members manage push_jobs" on push_jobs
  for all using (is_org_member(org_id)) with check (is_org_member(org_id));

-- locked_at is intentionally NOT added here — 0058_job_locks.sql already
-- owns that column (`add column if not exists locked_at`) and runs after
-- this migration in filename order; adding it here too would just be
-- redundant, not wrong, but keeping each column's addition owned by one
-- migration matches how the rest of this schema's history reads.
