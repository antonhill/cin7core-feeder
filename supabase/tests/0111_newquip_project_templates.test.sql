-- Transactional test for migration 0111 (versioned project templates). BEGIN/ROLLBACK - leaves no rows.
-- Covers: stage validation (100% total, names, positive whole bps), server-assigned versions, immutable history, no delete, one default per org, org isolation, RLS.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000011a1'), ('00000000-0000-0000-0000-0000000011a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000011b1', 'PT Org A'), ('00000000-0000-0000-0000-0000000011b2', 'PT Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000011b1', '00000000-0000-0000-0000-0000000011a1', 'member'), ('00000000-0000-0000-0000-0000000011b2', '00000000-0000-0000-0000-0000000011a2', 'member');

insert into newquip_project_templates (id, org_id, name, description, is_default, created_by_email)
values ('00000000-0000-0000-0000-0000000011c1', '00000000-0000-0000-0000-0000000011b1', 'Four stage', 'Deposit, manufacture, delivery, install', true, 'm@x'),
       ('00000000-0000-0000-0000-0000000011c2', '00000000-0000-0000-0000-0000000011b2', 'Org B template', '', false, 'm@x');

-- versions are assigned by the database, whatever the caller sends
insert into newquip_project_template_versions (org_id, template_id, version, stages, reason, created_by_email)
values ('00000000-0000-0000-0000-0000000011b1', '00000000-0000-0000-0000-0000000011c1', 99,
  '[{"name":"Deposit","bps":2500,"description":"","trigger":""},{"name":"Manufacture","bps":3000,"description":"","trigger":""},{"name":"Delivery","bps":3000,"description":"","trigger":""},{"name":"Install","bps":1500,"description":"","trigger":""}]', 'initial', 'm@x');
insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email)
values ('00000000-0000-0000-0000-0000000011b1', '00000000-0000-0000-0000-0000000011c1',
  '[{"name":"Deposit","bps":3000,"description":"","trigger":""},{"name":"Manufacture","bps":2500,"description":"","trigger":""},{"name":"Delivery","bps":3000,"description":"","trigger":""},{"name":"Install","bps":1500,"description":"","trigger":""}]', 'rebalanced', 'm@x');
do $$ begin
  if (select array_agg(version order by version) from newquip_project_template_versions where template_id = '00000000-0000-0000-0000-0000000011c1') <> array[1, 2] then raise exception 'versions must be 1 then 2'; end if;
end $$;

-- stage validation
select pg_temp.expect_denied($q$insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email) values ('00000000-0000-0000-0000-0000000011b1','00000000-0000-0000-0000-0000000011c1','[{"name":"A","bps":9999}]','x','m@x')$q$, 'total must be exactly 100%');
select pg_temp.expect_denied($q$insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email) values ('00000000-0000-0000-0000-0000000011b1','00000000-0000-0000-0000-0000000011c1','[{"name":"A","bps":10001}]','x','m@x')$q$, 'total over 100%');
select pg_temp.expect_denied($q$insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email) values ('00000000-0000-0000-0000-0000000011b1','00000000-0000-0000-0000-0000000011c1','[{"name":"A","bps":5000},{"name":"a","bps":5000}]','x','m@x')$q$, 'duplicate names (case-insensitive)');
select pg_temp.expect_denied($q$insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email) values ('00000000-0000-0000-0000-0000000011b1','00000000-0000-0000-0000-0000000011c1','[{"name":"A","bps":0},{"name":"B","bps":10000}]','x','m@x')$q$, 'zero share');
select pg_temp.expect_denied($q$insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email) values ('00000000-0000-0000-0000-0000000011b1','00000000-0000-0000-0000-0000000011c1','[{"name":"A","bps":5000.5},{"name":"B","bps":4999.5}]','x','m@x')$q$, 'fractional basis points');
select pg_temp.expect_denied($q$insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email) values ('00000000-0000-0000-0000-0000000011b1','00000000-0000-0000-0000-0000000011c1','[{"name":" ","bps":10000}]','x','m@x')$q$, 'blank name');
-- a template of another organisation cannot receive a version through a mismatched org
select pg_temp.expect_denied($q$insert into newquip_project_template_versions (org_id, template_id, stages, reason, created_by_email) values ('00000000-0000-0000-0000-0000000011b2','00000000-0000-0000-0000-0000000011c1','[{"name":"A","bps":10000}]','x','m@x')$q$, 'org/template mismatch');

-- history is immutable and never deleted
select pg_temp.expect_denied($q$update newquip_project_template_versions set reason = 'changed' where template_id = '00000000-0000-0000-0000-0000000011c1'$q$, 'version update');
select pg_temp.expect_denied($q$delete from newquip_project_template_versions where template_id = '00000000-0000-0000-0000-0000000011c1'$q$, 'version delete');
select pg_temp.expect_denied($q$delete from newquip_project_templates where id = '00000000-0000-0000-0000-0000000011c1'$q$, 'template delete');
select pg_temp.expect_denied($q$update newquip_project_templates set created_by_email = 'z@x' where id = '00000000-0000-0000-0000-0000000011c1'$q$, 'identity change');

-- one default per organisation; a retired template cannot be the default
select pg_temp.expect_denied($q$insert into newquip_project_templates (org_id, name, is_default, created_by_email) values ('00000000-0000-0000-0000-0000000011b1', 'Second default', true, 'm@x')$q$, 'second default');
select pg_temp.expect_denied($q$update newquip_project_templates set status = 'RETIRED' where id = '00000000-0000-0000-0000-0000000011c1'$q$, 'retiring the default without clearing it');
select pg_temp.expect_denied($q$insert into newquip_project_templates (org_id, name, created_by_email) values ('00000000-0000-0000-0000-0000000011b1', ' FOUR stage ', 'm@x')$q$, 'duplicate name (case-insensitive)');
update newquip_project_templates set is_default = false where id = '00000000-0000-0000-0000-0000000011c1';
update newquip_project_templates set status = 'RETIRED' where id = '00000000-0000-0000-0000-0000000011c1';

-- RLS: members read their own organisation only; no client writes
select pg_temp.act_as('00000000-0000-0000-0000-0000000011a1');
do $$ begin
  if (select count(*) from newquip_project_templates) <> 1 then raise exception 'a member must see only their own templates'; end if;
  if (select count(*) from newquip_project_template_versions) <> 2 then raise exception 'a member must see only their own versions'; end if;
end $$;
select pg_temp.expect_denied($q$insert into newquip_project_templates (org_id, name, created_by_email) values ('00000000-0000-0000-0000-0000000011b1', 'client write', 'x@x')$q$, 'client insert');
select pg_temp.expect_denied($q$update newquip_project_templates set name = 'x'$q$, 'client update');
select pg_temp.reset_role();

select 'OK: 0111 project templates' as result;
rollback;
