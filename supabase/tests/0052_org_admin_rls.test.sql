-- RLS regression test for Phase 0.3 / 0.4 (migration 0052_org_admin_rls.sql).
--
-- Self-contained and NON-DESTRUCTIVE: everything runs inside one transaction
-- that ROLLS BACK, so it can be run safely against any database (including
-- production) AFTER 0052 is applied — it creates throwaway org/users, asserts
-- the policies, and undoes it all.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0052_org_admin_rls.test.sql
-- Expect: "ALL RLS ASSERTIONS PASSED" and a ROLLBACK. Any failed assertion
-- raises an exception and aborts (ON_ERROR_STOP).

begin;

-- Table-level GRANTs to authenticated/anon (RLS then restricts which ROWS
-- are visible/writable within that) are applied by the Supabase platform
-- itself at project-creation time -- not something any migration in this
-- repo has ever had to state explicitly (confirmed: no migration anywhere
-- grants anything to authenticated/anon). A real hosted project already has
-- them; a from-scratch local CLI bootstrap (`supabase start` + our own
-- migrations only, no platform project-creation step) does not, confirmed
-- by a real CI run failing with "permission denied for table
-- cin7_instances" here. GRANT/REVOKE are transactional in Postgres, so
-- these are undone by this file's own ROLLBACK below just like everything
-- else it does -- safe to run against a real project (redundant, matches
-- what's already there) or a fresh local one (makes it actually work).
grant select, insert, update, delete on cin7_instances to authenticated, anon;
grant select, insert, update, delete on purchase_planner_settings to authenticated, anon;

-- Impersonate a given user id as the `authenticated` role (what Supabase does
-- per request); auth.uid() reads request.jwt.claims->>'sub'.
create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- Assertion helper: expect a statement to raise (be blocked by RLS).
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin
    execute sql;
    raise exception 'EXPECTED DENIED but succeeded: %', label;
  exception
    when insufficient_privilege or check_violation then return; -- RLS blocked it
    when others then
      -- A "new row violates row-level security policy" is a check_violation;
      -- anything else is an unexpected error we should see.
      raise;
  end;
end $$;

-- Assertion helper for UPDATE specifically: when the target row is filtered
-- out by an RLS policy's USING clause (not visible to this role at all —
-- confirmed live 2026-08-17 by running this exact scenario: 0 rows
-- affected, target value unchanged, NO exception raised), the UPDATE is a
-- silent no-op, not an error. expect_denied's exception-based check can
-- never catch this — it would report a false PASS on a write that never
-- happened, or worse, mask a real regression if the row ever became visible.
-- Genuinely checks the row was untouched instead of just hoping for an
-- exception. (An INSERT's WITH CHECK failure, or an UPDATE where the row
-- IS visible under USING but a separate WITH CHECK fails, still raises a
-- real check_violation — expect_denied stays correct for those.)
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
  org_a uuid := gen_random_uuid();
  org_b uuid := gen_random_uuid();
  u_owner uuid := gen_random_uuid();
  u_member uuid := gen_random_uuid();
  u_foreign uuid := gen_random_uuid();  -- member of org_b only
  inst_a uuid;
begin
  -- Seed (as the table owner / service context — RLS not enforced for the definer here).
  -- org_members.user_id references auth.users, so these throwaway ids need a
  -- real (if minimal) row there first — `id` is the only NOT NULL column
  -- with no default (confirmed against the live schema), so this is safe to
  -- run against any environment, not just one with pre-existing test users.
  insert into auth.users (id) values (u_owner), (u_member), (u_foreign);
  insert into organizations (id, name) values (org_a, 'RLS Test Org A'), (org_b, 'RLS Test Org B');
  insert into org_members (org_id, user_id, role) values
    (org_a, u_owner, 'owner'),
    (org_a, u_member, 'member'),
    (org_b, u_foreign, 'owner');
  insert into cin7_instances (org_id, name, account_id, application_key_encrypted, base_url, active)
    values (org_a, 'seed', 'acct', 'ciphertext', 'https://inventory.dearsystems.com/ExternalApi/v2', true)
    returning id into inst_a;

  ---------------------------------------------------------------- cin7_instances
  -- Ordinary member: no read, no write.
  perform pg_temp.act_as(u_member);
  if exists (select 1 from cin7_instances where id = inst_a) then
    raise exception 'FAIL: ordinary member can SELECT cin7_instances';
  end if;
  perform pg_temp.expect_no_effect(
    format('update cin7_instances set name=''hacked'' where id=%L', inst_a),
    'member UPDATE cin7_instances');
  perform pg_temp.expect_denied(
    format('insert into cin7_instances (org_id,name,account_id,application_key_encrypted,base_url,active) values (%L,''x'',''a'',''c'',''https://inventory.dearsystems.com/ExternalApi/v2'',true)', org_a),
    'member INSERT cin7_instances');

  -- Owner/admin: full access.
  perform pg_temp.act_as(u_owner);
  if not exists (select 1 from cin7_instances where id = inst_a) then
    raise exception 'FAIL: owner cannot SELECT cin7_instances';
  end if;
  update cin7_instances set name = 'owner-renamed' where id = inst_a; -- must succeed

  -- Foreign org member: no access to org_a's instance.
  perform pg_temp.act_as(u_foreign);
  if exists (select 1 from cin7_instances where id = inst_a) then
    raise exception 'FAIL: foreign-org user can SELECT another org''s instance';
  end if;
  perform pg_temp.expect_no_effect(
    format('update cin7_instances set name=''x'' where id=%L', inst_a),
    'foreign-org UPDATE cin7_instances');

  -- Anonymous: nothing.
  perform pg_temp.act_as_anon();
  if exists (select 1 from cin7_instances where id = inst_a) then
    raise exception 'FAIL: anonymous can SELECT cin7_instances';
  end if;

  ------------------------------------------------ purchase_planner_settings
  reset role;
  insert into purchase_planner_settings (org_id, home_currency, import_stock_months)
    values (org_a, 'ZAR', 4);

  -- Member: may READ, may NOT write.
  perform pg_temp.act_as(u_member);
  if not exists (select 1 from purchase_planner_settings where org_id = org_a) then
    raise exception 'FAIL: member cannot SELECT purchase_planner_settings (should be allowed)';
  end if;
  perform pg_temp.expect_no_effect(
    format('update purchase_planner_settings set import_stock_months=99 where org_id=%L', org_a),
    'member UPDATE purchase_planner_settings');

  -- Owner: may write.
  perform pg_temp.act_as(u_owner);
  update purchase_planner_settings set import_stock_months = 6 where org_id = org_a; -- must succeed

  reset role;
  raise notice 'ALL RLS ASSERTIONS PASSED';
end $$;

rollback;
