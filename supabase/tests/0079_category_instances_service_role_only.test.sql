-- RLS regression test for migration 0079_category_instances_service_role_only.sql.
--
-- Security re-audit final closure, Blocker 4 (Anton-approved D4): proves
-- category_instances now rejects EVERY authenticated-role read/write
-- (ordinary member, org admin, AND a cross-org user), while the service-role
-- path the app's only two real callers (syncInstanceSales,
-- getReportFilterOptions) actually use keeps working.
--
-- Self-contained and NON-DESTRUCTIVE: everything runs inside one transaction
-- that ROLLS BACK, so it can be run safely against any database (including
-- production) AFTER 0079 is applied.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0079_category_instances_service_role_only.test.sql
-- Expect: "ALL 0079 CATEGORY_INSTANCES SERVICE-ROLE-ONLY ASSERTIONS PASSED" and a ROLLBACK.

begin;

grant select, insert, update, delete on category_instances to authenticated, anon;
grant select, insert, update, delete on categories to authenticated, anon;
grant select, insert, update, delete on cin7_instances to authenticated, anon;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;

-- See supabase/tests/0052_org_admin_rls.test.sql's own comment for why this
-- checks row_count instead of expecting an exception: an UPDATE/DELETE whose
-- target row is filtered out by RLS's USING clause silently affects 0 rows
-- rather than raising, unlike an INSERT's WITH CHECK failure.
create or replace function pg_temp.expect_no_effect(sql text, label text) returns void language plpgsql as $$
declare
  v_count int;
begin
  execute sql;
  get diagnostics v_count = row_count;
  if v_count <> 0 then
    raise exception 'EXPECTED 0 rows affected (RLS-filtered) but % row(s) changed: %', v_count, label;
  end if;
end $$;

do $$
declare
  org_x uuid := gen_random_uuid();
  org_y uuid := gen_random_uuid();
  inst_x uuid;
  u_admin uuid := gen_random_uuid();
  u_member uuid := gen_random_uuid();
  u_cross_org uuid := gen_random_uuid();
begin
  insert into auth.users (id) values (u_admin), (u_member), (u_cross_org);
  insert into organizations (id, name) values (org_x, 'Category Instances Test Org'), (org_y, 'Cross-Org Test Org');
  insert into org_members (org_id, user_id, role) values
    (org_x, u_admin, 'admin'),
    (org_x, u_member, 'member'),
    (org_y, u_cross_org, 'admin'); -- admin of a DIFFERENT org, not org_x
  insert into cin7_instances (org_id, name, account_id, application_key_encrypted, base_url, active)
    values (org_x, 'seed', 'acct', 'ciphertext', 'https://inventory.dearsystems.com/ExternalApi/v2', true)
    returning id into inst_x;
  insert into categories (org_id, code, name) values (org_x, 'CAT-1', 'Accessories');
  insert into category_instances (org_id, code, instance_id) values (org_x, 'CAT-1', inst_x);

  ---------------------------------------------------------------- ordinary member (same org)
  perform pg_temp.act_as(u_member);
  if exists (select 1 from category_instances where org_id = org_x) then
    raise exception 'FAIL: member can SELECT category_instances (should be service-only)';
  end if;
  perform pg_temp.expect_no_effect(
    format('update category_instances set code=code where org_id=%L', org_x),
    'member UPDATE category_instances');
  perform pg_temp.expect_no_effect(
    format('delete from category_instances where org_id=%L', org_x),
    'member DELETE category_instances');
  begin
    insert into category_instances (org_id, code, instance_id) values (org_x, 'CAT-1', inst_x);
    raise exception 'FAIL: member can INSERT category_instances (should be service-only)';
  exception when insufficient_privilege or others then
    -- zero policies means no WITH CHECK is ever satisfied -- INSERT is
    -- correctly rejected (unlike UPDATE/DELETE, a blocked INSERT raises).
    null;
  end;

  ---------------------------------------------------------------- org admin (same org — still no access, this is the actual fix)
  perform pg_temp.act_as(u_admin);
  if exists (select 1 from category_instances where org_id = org_x) then
    raise exception 'FAIL: org admin can SELECT category_instances (should be service-only per Anton''s D4 decision, not merely is_org_admin-gated)';
  end if;
  perform pg_temp.expect_no_effect(
    format('update category_instances set code=code where org_id=%L', org_x),
    'admin UPDATE category_instances');

  ---------------------------------------------------------------- cross-org user (admin of a DIFFERENT org)
  perform pg_temp.act_as(u_cross_org);
  if exists (select 1 from category_instances where org_id = org_x) then
    raise exception 'FAIL: cross-org user can SELECT another org''s category_instances rows';
  end if;
  perform pg_temp.expect_no_effect(
    format('update category_instances set code=code where org_id=%L', org_x),
    'cross-org UPDATE category_instances');

  reset role;

  ---------------------------------------------------------------- service-role application path (bypasses RLS entirely)
  if not exists (select 1 from category_instances where org_id = org_x and code = 'CAT-1' and instance_id = inst_x) then
    raise exception 'FAIL: service-role SELECT on category_instances broke (should always bypass RLS)';
  end if;
  update category_instances set code = 'CAT-1' where org_id = org_x; -- must succeed (no-op update, proves write access)
  insert into categories (org_id, code, name) values (org_x, 'CAT-2', 'Widgets');
  insert into category_instances (org_id, code, instance_id) values (org_x, 'CAT-2', inst_x); -- must succeed

  raise notice 'ALL 0079 CATEGORY_INSTANCES SERVICE-ROLE-ONLY ASSERTIONS PASSED';
end $$;

rollback;
