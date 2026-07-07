-- Records every live write this app makes to a client's Cin7 instance (Data
-- Audit fixes/merges, sync pushes) — so a client can see what changed, when,
-- and by whom, rather than trusting a black box. Writes only ever happen via
-- the service-role client from src/lib/activity-log.ts; org members get
-- read-only access to their own org's rows.
create table if not exists activity_log (
  id             uuid primary key default gen_random_uuid(),
  org_id         uuid not null references organizations (id) on delete cascade,
  instance_id    uuid references cin7_instances (id) on delete set null,
  -- Nullable, not a foreign key to auth.users (not queryable via regular
  -- policies) — actor_email is a denormalized snapshot so the log still
  -- reads sensibly if the user is later removed from the org. Null actor
  -- means a system-triggered action (e.g. the scheduled cron sync), not a
  -- specific person.
  actor_user_id  uuid,
  actor_email    text,
  action         text not null,
  summary        text not null,
  detail         jsonb,
  created_at     timestamptz not null default now()
);

create index if not exists activity_log_org_created_idx on activity_log (org_id, created_at desc);

alter table activity_log enable row level security;

create policy "org members read activity_log" on activity_log
  for select using (is_org_member(org_id));
