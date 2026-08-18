-- Security re-audit final closure, regression guardrail #6.
--
-- Blocker 4 (category_instances) existed because a policy's own NAME said
-- "org admins manage ..." while its actual USING clause called
-- is_org_member(...), not is_org_admin(...) -- an internal contradiction
-- that slipped past three prior audit rounds because nothing checked a
-- policy's name against its own qual text. This test is that check, run
-- generically against every policy in the public schema, not just the one
-- table that happened to be wrong -- so a future migration reintroducing
-- this exact class of bug (writing "admin" in a policy name but leaving the
-- looser is_org_member check in the qual) fails CI immediately.
--
-- Read-only introspection against pg_policies -- no seed data needed, safe
-- to run against any database including production, nothing to roll back.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0081_rls_policy_name_intent_check.test.sql
-- Expect: "ALL 0081 RLS POLICY-NAME-INTENT ASSERTIONS PASSED".

do $$
declare
  r record;
  offenders text := '';
  offender_count int := 0;
begin
  -- Every policy whose name contains "admin" must actually gate on
  -- is_org_admin(...) somewhere in its qual or with_check clause -- a name
  -- promising admin-only enforcement that actually reads is_org_member(...)
  -- (or nothing at all) is exactly the Blocker 4 bug class.
  for r in
    select schemaname, tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and policyname ~* 'admin'
  loop
    if coalesce(r.qual, '') !~ 'is_org_admin\(' and coalesce(r.with_check, '') !~ 'is_org_admin\(' then
      offender_count := offender_count + 1;
      offenders := offenders || format(E'\n  - %s.%s policy %L: qual=%s with_check=%s', r.schemaname, r.tablename, r.policyname, r.qual, r.with_check);
    end if;
  end loop;

  if offender_count > 0 then
    raise exception 'FAIL: % polic(y/ies) named as admin-gated do not actually check is_org_admin():%', offender_count, offenders;
  end if;

  raise notice 'ALL 0081 RLS POLICY-NAME-INTENT ASSERTIONS PASSED';
end $$;
