-- A single flag marking who can see the /admin dashboard (all orgs, invite
-- new ones) — not scoped to any one org, since Spark (not a client) manages
-- this. Checked only via the service-role client in server actions, never
-- exposed through RLS to a session-scoped client, so no read/write policies
-- are needed here.
create table if not exists super_admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table super_admins enable row level security;
