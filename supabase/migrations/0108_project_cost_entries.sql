-- Direct NON-STOCK project costs (additive; applies after 0107). NOT applied to hosted Supabase.
--
-- Installation labour, transport/delivery, subcontractors, site expenses and other direct project costs that Cin7 inventory/assembly valuation does
-- not carry. Each entry is COMMITTED (expected) or INCURRED (actual). An entry already represented inside a Cin7 inventory or assembly valuation is
-- recorded for visibility with in_cin7_valuation = true and is EXCLUDED from every total (no double counting). Entries are never deleted or edited:
-- only a COMMITTED entry may become INCURRED, and any entry may be voided once, with a reason. INTERNAL cost data: readable by org owners/admins only.
-- Nothing here calls Cin7 and no existing row is modified.

create table if not exists project_cost_entries (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  project_id  uuid not null,
  category    text not null check (category in ('INSTALLATION_LABOUR', 'TRANSPORT_DELIVERY', 'SUBCONTRACTOR', 'SITE_EXPENSE', 'OTHER_DIRECT')),
  description text not null check (length(btrim(description)) > 0),
  supplier    text,
  reference   text,
  amount_cents bigint not null check (amount_cents > 0),
  state       text not null default 'COMMITTED' check (state in ('COMMITTED', 'INCURRED')),
  in_cin7_valuation boolean not null default false,
  incurred_on date,
  recorded_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  voided_at   timestamptz,
  voided_by_email text,
  void_reason text,
  foreign key (project_id, org_id) references projects (id, org_id) on delete cascade,
  check ((state = 'INCURRED') = (incurred_on is not null)),
  check ((voided_at is null) = (voided_by_email is null and void_reason is null))
);
create index if not exists project_cost_entries_project_idx on project_cost_entries (project_id, state);

create or replace function project_cost_entries_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from projects where id = old.project_id) and exists (select 1 from organizations where id = old.org_id) then
      raise exception 'project_cost_entries %: cost entries are an audit record and are never deleted', old.id;
    end if;
    return old; -- cascade from a deleted project / organization
  end if;
  if tg_op = 'INSERT' then
    if new.voided_at is not null then raise exception 'project_cost_entries: an entry cannot be created void'; end if;
    return new;
  end if;
  -- UPDATE: identity and amount are immutable
  if new.org_id is distinct from old.org_id or new.project_id is distinct from old.project_id or new.category is distinct from old.category
     or new.description is distinct from old.description or new.supplier is distinct from old.supplier or new.reference is distinct from old.reference
     or new.amount_cents is distinct from old.amount_cents or new.in_cin7_valuation is distinct from old.in_cin7_valuation
     or new.recorded_by_email is distinct from old.recorded_by_email or new.created_at is distinct from old.created_at then
    raise exception 'project_cost_entries %: only the state (COMMITTED -> INCURRED) and voiding may change', old.id;
  end if;
  if old.voided_at is not null then raise exception 'project_cost_entries %: a voided entry is final', old.id; end if;
  if new.state is distinct from old.state and not (old.state = 'COMMITTED' and new.state = 'INCURRED') then
    raise exception 'project_cost_entries %: illegal state change % -> %', old.id, old.state, new.state;
  end if;
  if new.state = old.state and new.incurred_on is distinct from old.incurred_on then
    raise exception 'project_cost_entries %: the incurred date is fixed once set', old.id;
  end if;
  return new;
end;
$$;
create trigger project_cost_entries_guard_trg before insert or update or delete on project_cost_entries
  for each row execute function project_cost_entries_guard();

alter table project_cost_entries enable row level security;
create policy "org admins read project_cost_entries" on project_cost_entries for select using (is_org_admin(org_id));
-- All writes go through the service role (server actions); no insert/update/delete policies are granted.

revoke all on function project_cost_entries_guard() from public, anon;
