-- Reusable, version-controlled package -> Cin7 SKU mappings (additive; applies after 0108). NOT applied to hosted Supabase.
--
-- A manager's resolution of a quoted package (for example penning sold by the running metre) into real Cin7 SKUs can be saved once and offered again
-- for later projects. Every change is a NEW VERSION; earlier versions are kept as history and are never edited. A project that used a mapping keeps its
-- OWN frozen copy of the resolution in its baseline snapshot (it records which version it came from), so a later version never changes an approved
-- quotation or an existing project. Nothing here calls Cin7 and no existing row is modified.

create table if not exists newquip_package_mappings (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  package_key text not null check (length(btrim(package_key)) > 0),
  version     integer not null check (version >= 1),
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUPERSEDED')),
  -- [{ "sku": text, "factor": number > 0, "unit": text, "role": "FINISHED_GOOD" | "BOM_COMPONENT" }, ...]; validated by the application, shape-checked here
  lines       jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) > 0),
  reason      text not null check (length(btrim(reason)) > 0),
  created_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  superseded_at timestamptz,
  unique (org_id, package_key, version),
  check ((status = 'SUPERSEDED') = (superseded_at is not null))
);
-- at most ONE active version per package
create unique index if not exists newquip_package_mappings_one_active_idx on newquip_package_mappings (org_id, package_key) where status = 'ACTIVE';

create or replace function newquip_package_mappings_guard() returns trigger language plpgsql set search_path = public as $$
declare v_max integer;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then
      raise exception 'newquip_package_mappings %: mapping history is never deleted', old.id;
    end if;
    return old; -- cascade from a deleted organization
  end if;
  if tg_op = 'INSERT' then
    -- the version is assigned here (max + 1), never trusted from the caller, and the previous ACTIVE version is superseded atomically
    select coalesce(max(version), 0) into v_max from newquip_package_mappings where org_id = new.org_id and package_key = new.package_key;
    new.version := v_max + 1;
    new.status := 'ACTIVE';
    new.superseded_at := null;
    update newquip_package_mappings set status = 'SUPERSEDED', superseded_at = clock_timestamp()
      where org_id = new.org_id and package_key = new.package_key and status = 'ACTIVE';
    return new;
  end if;
  -- UPDATE: only the one-way ACTIVE -> SUPERSEDED change (done by the insert trigger above); content is immutable
  if new.org_id is distinct from old.org_id or new.package_key is distinct from old.package_key or new.version is distinct from old.version
     or new.lines is distinct from old.lines or new.reason is distinct from old.reason or new.created_by_email is distinct from old.created_by_email
     or new.created_at is distinct from old.created_at then
    raise exception 'newquip_package_mappings %: a mapping version is immutable; save a new version instead', old.id;
  end if;
  if old.status = 'SUPERSEDED' and (new.status is distinct from old.status or new.superseded_at is distinct from old.superseded_at) then
    raise exception 'newquip_package_mappings %: a superseded version is final', old.id;
  end if;
  if new.status is distinct from old.status and not (old.status = 'ACTIVE' and new.status = 'SUPERSEDED') then
    raise exception 'newquip_package_mappings %: illegal status change', old.id;
  end if;
  return new;
end;
$$;
create trigger newquip_package_mappings_guard_trg before insert or update or delete on newquip_package_mappings
  for each row execute function newquip_package_mappings_guard();

alter table newquip_package_mappings enable row level security;
create policy "org members read newquip_package_mappings" on newquip_package_mappings for select using (is_org_member(org_id));
-- All writes go through the service role (server actions); no insert/update/delete policies are granted.
-- Belt and braces on top of RLS: the client roles get SELECT only (Supabase's default also grants INSERT/UPDATE/DELETE/TRUNCATE, and TRUNCATE is not subject to RLS).
revoke all on newquip_package_mappings from anon, authenticated;
grant select on newquip_package_mappings to authenticated;

revoke all on function newquip_package_mappings_guard() from public, anon;
