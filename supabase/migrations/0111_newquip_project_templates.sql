-- Reusable, versioned NewQuip PROJECT (billing milestone) templates (additive; applies after 0110). NOT applied to hosted Supabase.
--
-- A template is a named list of billing stages with percentages that must total exactly 100%. Every change to the stages is a NEW immutable VERSION.
-- A project created from a template keeps its OWN stages (ordinary project data) plus a provenance record of the template version it came from, so a later
-- template edit can never alter an existing project or an approved quotation. Nothing here calls Cin7 and no existing row is modified.

create table if not exists newquip_project_templates (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations (id) on delete cascade,
  name        text not null check (length(btrim(name)) > 0),
  description text not null default '',
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'RETIRED')),
  is_default  boolean not null default false,
  created_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  updated_at  timestamptz not null default clock_timestamp(),
  check (not (is_default and status <> 'ACTIVE')),
  unique (id, org_id)
);
create unique index if not exists newquip_project_templates_name_idx on newquip_project_templates (org_id, lower(btrim(name)));
-- at most ONE default per organisation
create unique index if not exists newquip_project_templates_one_default_idx on newquip_project_templates (org_id) where is_default;

create table if not exists newquip_project_template_versions (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null,
  template_id uuid not null,
  version     integer not null check (version >= 1),
  -- [{ "name": text, "bps": integer > 0, "description": text, "trigger": text }, ...] in claim order; bps total exactly 10000; validated again by the trigger
  stages      jsonb not null check (jsonb_typeof(stages) = 'array' and jsonb_array_length(stages) > 0),
  reason      text not null check (length(btrim(reason)) > 0),
  created_by_email text not null,
  created_at  timestamptz not null default clock_timestamp(),
  foreign key (template_id, org_id) references newquip_project_templates (id, org_id) on delete cascade,
  unique (template_id, version)
);

create or replace function newquip_project_template_versions_guard() returns trigger language plpgsql set search_path = public as $$
declare v_max integer; v_total bigint := 0; v_names text[] := '{}'; s jsonb; v_bps numeric; v_name text;
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from newquip_project_templates where id = old.template_id) then
      raise exception 'newquip_project_template_versions %: template history is never deleted', old.id;
    end if;
    return old; -- cascade from a deleted template / organization
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'newquip_project_template_versions %: a template version is immutable; save a new version instead', old.id;
  end if;
  -- INSERT: validate the stages, then assign the version (max + 1) - never trusted from the caller
  for s in select * from jsonb_array_elements(new.stages) loop
    if jsonb_typeof(s) <> 'object' then raise exception 'newquip_project_template_versions: every stage must be an object'; end if;
    v_name := lower(btrim(coalesce(s->>'name', '')));
    if v_name = '' then raise exception 'newquip_project_template_versions: every stage needs a name'; end if;
    if v_name = any(v_names) then raise exception 'newquip_project_template_versions: duplicate stage name %', s->>'name'; end if;
    v_names := v_names || v_name;
    if jsonb_typeof(s->'bps') <> 'number' then raise exception 'newquip_project_template_versions: stage % needs a numeric bps', s->>'name'; end if;
    v_bps := (s->>'bps')::numeric;
    if v_bps <> trunc(v_bps) or v_bps <= 0 then raise exception 'newquip_project_template_versions: stage % must have a positive whole-basis-point share', s->>'name'; end if;
    v_total := v_total + v_bps::bigint;
  end loop;
  if v_total <> 10000 then raise exception 'newquip_project_template_versions: stage percentages total %, not 100%%', (v_total / 100.0); end if;
  select coalesce(max(version), 0) into v_max from newquip_project_template_versions where template_id = new.template_id;
  new.version := v_max + 1;
  return new;
end;
$$;
create trigger newquip_project_template_versions_guard_trg before insert or update or delete on newquip_project_template_versions
  for each row execute function newquip_project_template_versions_guard();

-- Only the descriptive fields, status and default flag of a template may change; identity never.
create or replace function newquip_project_templates_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from organizations where id = old.org_id) then
      raise exception 'newquip_project_templates %: templates are retired, never deleted', old.id;
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if new.org_id is distinct from old.org_id or new.created_by_email is distinct from old.created_by_email or new.created_at is distinct from old.created_at then
      raise exception 'newquip_project_templates %: identity is immutable', old.id;
    end if;
    new.updated_at := clock_timestamp();
  end if;
  return new;
end;
$$;
create trigger newquip_project_templates_guard_trg before update or delete on newquip_project_templates
  for each row execute function newquip_project_templates_guard();

alter table newquip_project_templates         enable row level security;
alter table newquip_project_template_versions enable row level security;
create policy "org members read newquip_project_templates"         on newquip_project_templates         for select using (is_org_member(org_id));
create policy "org members read newquip_project_template_versions" on newquip_project_template_versions for select using (is_org_member(org_id));
-- All writes go through the service role (server actions); no insert/update/delete policies are granted.
-- Belt and braces on top of RLS: the client roles get SELECT only (Supabase's default also grants INSERT/UPDATE/DELETE/TRUNCATE, and TRUNCATE is not subject to RLS).
revoke all on newquip_project_templates, newquip_project_template_versions from anon, authenticated;
grant select on newquip_project_templates, newquip_project_template_versions to authenticated;

revoke all on function newquip_project_template_versions_guard() from public, anon;
revoke all on function newquip_project_templates_guard() from public, anon;
