-- Delivery allocation + commercial milestone confirmation (additive; applies after 0106). NOT applied to hosted Supabase.
--
--  * project_milestone_confirmations: a manager's recorded confirmation (with evidence) that a commercial milestone has been met.
--    Append-only history; physical progress and claim eligibility stay independent of it.
--  * project_deliveries / project_delivery_allocations: PLANNED deliveries and the SKU quantities assigned to them, per billing project
--    (BASE and each variation billing project are independent because project_id is the billing project). An allocation is a plan for
--    invoicing, NOT a Cin7 stock reservation and NOT a shipment.
--  * project_delivery_events: append-only audit of every allocation change with its reason.
-- Nothing here calls Cin7 and no existing row is modified.

create table if not exists project_milestone_confirmations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  stage_id    uuid not null,
  confirmed_by_email text not null,
  note        text not null check (length(btrim(note)) > 0),
  evidence_ref text,
  confirmed_at timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  foreign key (stage_id, project_id, org_id) references project_stages (id, project_id, org_id) on delete cascade
);
create index if not exists project_milestone_confirmations_stage_idx on project_milestone_confirmations (stage_id, confirmed_at);

create table if not exists project_deliveries (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  label       text not null check (length(btrim(label)) > 0),
  planned_date date,
  status      text not null default 'PLANNED' check (status in ('PLANNED', 'LOADING', 'DISPATCHED', 'CANCELLED')),
  created_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  unique (id, project_id, org_id),
  unique (project_id, label)
);

create table if not exists project_delivery_allocations (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  delivery_id uuid not null,
  sku         text not null check (length(btrim(sku)) > 0),
  quantity    numeric not null check (quantity > 0),
  updated_by_email text not null,
  updated_at  timestamptz not null default clock_timestamp(),
  foreign key (delivery_id, project_id, org_id) references project_deliveries (id, project_id, org_id) on delete cascade,
  unique (delivery_id, sku)
);
create index if not exists project_delivery_allocations_project_idx on project_delivery_allocations (project_id, sku);

create table if not exists project_delivery_events (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  delivery_id uuid not null,
  sku         text,
  action      text not null check (action in ('DELIVERY_CREATED', 'DELIVERY_STATUS', 'ALLOCATION_SET', 'ALLOCATION_REMOVED', 'DELIVERY_CANCELLED')),
  from_quantity numeric,
  to_quantity   numeric,
  reason      text,
  actor_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade
);
create index if not exists project_delivery_events_project_idx on project_delivery_events (project_id, created_at);

-- Audit and confirmation history are append-only.
create or replace function project_append_only_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
    raise exception '%: rows are an audit record and are never updated or deleted', tg_table_name;
  end if;
  return old; -- cascade from a deleted project / organization
end;
$$;
create trigger project_delivery_events_append_only_trg before update or delete on project_delivery_events
  for each row execute function project_append_only_guard();
create trigger project_milestone_confirmations_append_only_trg before update or delete on project_milestone_confirmations
  for each row execute function project_append_only_guard();

-- A cancelled delivery can carry no allocations; variation billing projects keep their own deliveries (project_id is the billing project).
create or replace function project_delivery_allocations_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if exists (select 1 from project_deliveries where id = new.delivery_id and status = 'CANCELLED') then
    raise exception 'project_delivery_allocations: a cancelled delivery cannot hold allocations';
  end if;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
create trigger project_delivery_allocations_guard_trg before insert or update on project_delivery_allocations
  for each row execute function project_delivery_allocations_guard();

alter table project_milestone_confirmations enable row level security;
alter table project_deliveries              enable row level security;
alter table project_delivery_allocations    enable row level security;
alter table project_delivery_events         enable row level security;
create policy "org members read project_milestone_confirmations" on project_milestone_confirmations for select using (is_org_member(org_id));
create policy "org members read project_deliveries"              on project_deliveries              for select using (is_org_member(org_id));
create policy "org members read project_delivery_allocations"    on project_delivery_allocations    for select using (is_org_member(org_id));
create policy "org members read project_delivery_events"         on project_delivery_events         for select using (is_org_member(org_id));
-- All writes go through the service role (server actions); no insert/update/delete policies are granted.
-- Belt and braces on top of RLS: the client roles get SELECT only (Supabase's default also grants INSERT/UPDATE/DELETE/TRUNCATE, and TRUNCATE is not subject to RLS).
revoke all on project_milestone_confirmations, project_deliveries, project_delivery_allocations, project_delivery_events from anon, authenticated;
grant select on project_milestone_confirmations, project_deliveries, project_delivery_allocations, project_delivery_events to authenticated;

revoke all on function project_append_only_guard() from public, anon;
revoke all on function project_delivery_allocations_guard() from public, anon;
