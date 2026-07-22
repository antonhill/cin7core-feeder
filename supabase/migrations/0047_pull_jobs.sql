-- Resumable background job for Migrate's Pull step — mirrors push_jobs (the
-- Push-to-Cin7 background job shipped 2026-07-19), applied to the same
-- class of problem on the Pull side: pulling a real Cin7 instance's full
-- product/customer/supplier catalog plus committing all 6 import kinds
-- synchronously in one request blows past Vercel's function duration limit
-- (/migrate never had /import's and /reports's maxDuration=300 override in
-- the first place — see the new src/app/migrate/layout.tsx). Confirmed live
-- 2026-07-22 against a real instance (I-Light and LBL / "Lights by Linea").
--
-- Unlike push_jobs, there's no per-row content_hash/synced_hash checkpoint
-- to make a naive re-run cheap — fetchAllProductsWithBom/fetchAllCustomers/
-- fetchAllSuppliers always fetch the whole catalog for their kind. So the
-- resumable unit here is coarser: one of 3 fetch groups (products+BOM,
-- customers+addresses, suppliers+addresses — see PULL_GROUP_ORDER in
-- src/migrate/pull-instance.ts), tracked in completed_groups rather than a
-- per-row state table.
--
-- Note: push_jobs itself has no migration file in this repo — it was
-- applied directly to the live DB and the file was never committed. This
-- migration exists so pull_jobs doesn't repeat that gap.
create type pull_job_status as enum ('running', 'done', 'failed');

create table pull_jobs (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations (id) on delete cascade,
  source_instance_id uuid not null references cin7_instances (id) on delete cascade,
  status             pull_job_status not null default 'running',
  completed_groups   text[] not null default '{}',
  results            jsonb not null default '{}'::jsonb,
  error              text,
  created_by         uuid references auth.users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index pull_jobs_org_id_idx on pull_jobs (org_id);

alter table pull_jobs enable row level security;

-- Same shape as push_jobs' live policy: the real authorization boundary is
-- requireCurrentOrg() in the server actions, RLS is defense in depth.
create policy "org members manage pull_jobs" on pull_jobs
  for all using (is_org_member(org_id)) with check (is_org_member(org_id));
