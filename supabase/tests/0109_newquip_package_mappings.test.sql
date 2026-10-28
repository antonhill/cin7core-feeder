-- Transactional test for migration 0109 (versioned package mappings). BEGIN/ROLLBACK - leaves no rows.
-- Covers: shape constraints, server-assigned versions, one ACTIVE per package, history immutable, no delete, org isolation, RLS.
begin;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;
create or replace function pg_temp.expect_no_rows_changed(sql text, label text) returns void language plpgsql as $$
declare n bigint;
begin
  begin execute sql; get diagnostics n = row_count; exception when others then return; end;
  if n <> 0 then raise exception 'EXPECTED 0 rows changed but % changed: %', n, label; end if;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000009a1'), ('00000000-0000-0000-0000-0000000009a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000009b1', 'PM Org A'), ('00000000-0000-0000-0000-0000000009b2', 'PM Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000009b1', '00000000-0000-0000-0000-0000000009a1', 'member'), ('00000000-0000-0000-0000-0000000009b2', '00000000-0000-0000-0000-0000000009a2', 'member');

-- versions are assigned by the database, whatever the caller sends
insert into newquip_package_mappings (org_id, package_key, version, lines, reason, created_by_email)
values ('00000000-0000-0000-0000-0000000009b1', 'penning_package', 99, '[{"sku":"T-1","factor":0.05,"unit":"roll","role":"FINISHED_GOOD"}]', 'initial', 'm@x');
insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email)
values ('00000000-0000-0000-0000-0000000009b1', 'penning_package', '[{"sku":"T-1","factor":0.06,"unit":"roll","role":"FINISHED_GOOD"},{"sku":"T-2","factor":1,"unit":"each","role":"BOM_COMPONENT"}]', 'corrected roll length', 'm@x');
insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email)
values ('00000000-0000-0000-0000-0000000009b1', 'led_light', '[{"sku":"T-3","factor":1,"unit":"each","role":"FINISHED_GOOD"}]', 'first', 'm@x');
do $$ begin
  if (select array_agg(version order by version) from newquip_package_mappings where package_key = 'penning_package') <> array[1, 2] then raise exception 'versions must be 1 then 2, got %', (select array_agg(version order by version) from newquip_package_mappings where package_key = 'penning_package'); end if;
  if (select count(*) from newquip_package_mappings where package_key = 'penning_package' and status = 'ACTIVE') <> 1 then raise exception 'exactly one ACTIVE version per package'; end if;
  if (select version from newquip_package_mappings where package_key = 'penning_package' and status = 'ACTIVE') <> 2 then raise exception 'the newest version must be the ACTIVE one'; end if;
  if (select status from newquip_package_mappings where package_key = 'penning_package' and version = 1) <> 'SUPERSEDED' then raise exception 'version 1 must be superseded'; end if;
  if (select version from newquip_package_mappings where package_key = 'led_light') <> 1 then raise exception 'packages version independently'; end if;
end $$;

-- shape and content constraints
select pg_temp.expect_denied($q$insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email) values ('00000000-0000-0000-0000-0000000009b1','x','[]','r','m@x')$q$, 'empty lines');
select pg_temp.expect_denied($q$insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email) values ('00000000-0000-0000-0000-0000000009b1','x','{"sku":"A"}','r','m@x')$q$, 'lines not an array');
select pg_temp.expect_denied($q$insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email) values ('00000000-0000-0000-0000-0000000009b1','x','[{"sku":"A"}]',' ','m@x')$q$, 'blank reason');
select pg_temp.expect_denied($q$insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email) values ('00000000-0000-0000-0000-0000000009b1',' ','[{"sku":"A"}]','r','m@x')$q$, 'blank package key');

-- history is immutable and never deleted
select pg_temp.expect_denied($q$update newquip_package_mappings set lines = '[{"sku":"HACK","factor":1}]' where package_key = 'penning_package' and version = 2$q$, 'edit an active version');
select pg_temp.expect_denied($q$update newquip_package_mappings set reason = 'rewritten' where package_key = 'penning_package' and version = 1$q$, 'edit a superseded version');
select pg_temp.expect_denied($q$update newquip_package_mappings set status = 'ACTIVE', superseded_at = null where package_key = 'penning_package' and version = 1$q$, 'resurrect a superseded version');
select pg_temp.expect_denied($q$delete from newquip_package_mappings where package_key = 'penning_package'$q$, 'delete history');
select pg_temp.expect_denied($q$update newquip_package_mappings set version = 7 where package_key = 'led_light'$q$, 'renumber a version');

-- RLS and organisation isolation
select pg_temp.act_as('00000000-0000-0000-0000-0000000009a1');
do $$ begin if (select count(*) from newquip_package_mappings) <> 3 then raise exception 'member A should see its 3 versions'; end if; end $$;
select pg_temp.expect_denied($q$insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email) values ('00000000-0000-0000-0000-0000000009b1','z','[{"sku":"A"}]','r','m@x')$q$, 'member insert');
select pg_temp.expect_no_rows_changed($q$update newquip_package_mappings set status = 'SUPERSEDED', superseded_at = now()$q$, 'member supersede');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000009a2');
do $$ begin if (select count(*) from newquip_package_mappings) <> 0 then raise exception 'org B must not see org A mappings'; end if; end $$;
select pg_temp.reset_role();
-- another org can use the same package key with its own version 1
insert into newquip_package_mappings (org_id, package_key, lines, reason, created_by_email) values ('00000000-0000-0000-0000-0000000009b2', 'penning_package', '[{"sku":"B-1","factor":1}]', 'org B', 'm@x');
do $$ begin
  if (select version from newquip_package_mappings where org_id = '00000000-0000-0000-0000-0000000009b2') <> 1 then raise exception 'org B versions independently'; end if;
  if (select count(*) from newquip_package_mappings where org_id = '00000000-0000-0000-0000-0000000009b1' and status = 'ACTIVE') <> 2 then raise exception 'org A active count unchanged by org B'; end if;
end $$;
-- cascade from the organisation
delete from organizations where id = '00000000-0000-0000-0000-0000000009b2';
do $$ begin if (select count(*) from newquip_package_mappings where org_id = '00000000-0000-0000-0000-0000000009b2') <> 0 then raise exception 'organisation delete must cascade'; end if; end $$;

select 'ALL 0109 NEWQUIP PACKAGE MAPPING TESTS PASSED' as result;
rollback;
