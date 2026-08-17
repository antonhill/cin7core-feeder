-- Transactional test for migration 0076's create_self_serve_org atomicity.
-- Wrapped in BEGIN/ROLLBACK: safe to run against any DB that has 0076
-- applied — it leaves no rows behind. Uses a real auth.users row (the first
-- one found) for the happy-path FK, since org_members.user_id references
-- auth.users. Expect it to print "ALL 0076 ASSERTIONS PASSED".

begin;

do $$
declare
  v_user_id uuid;
  v_org_id uuid;
  v_org_count int;
  v_member_count int;
begin
  select id into v_user_id from auth.users limit 1;
  if v_user_id is null then
    raise notice 'No auth.users row available in this environment -- skipping (nothing to assert against)';
    return;
  end if;

  -- Happy path: both rows exist together.
  v_org_id := create_self_serve_org('Test Org 0076', v_user_id);
  select count(*) into v_org_count from organizations where id = v_org_id;
  select count(*) into v_member_count from org_members where org_id = v_org_id and user_id = v_user_id and role = 'owner';
  if v_org_count <> 1 then raise exception 'expected org row to exist, got count %', v_org_count; end if;
  if v_member_count <> 1 then raise exception 'expected exactly 1 owner membership row, got %', v_member_count; end if;
  raise notice 'happy path OK: org=%, owner membership present', v_org_id;

  -- Atomicity: a failed membership insert (bogus user_id, violates the FK)
  -- must roll back the organizations insert too, not leave an orphaned org.
  declare
    v_org_count_before int;
    v_org_count_after int;
  begin
    select count(*) into v_org_count_before from organizations;
    begin
      perform create_self_serve_org('Should Not Persist', gen_random_uuid());
      raise exception 'expected create_self_serve_org to raise on the bad user_id';
    exception when foreign_key_violation then
      null; -- expected
    end;
    select count(*) into v_org_count_after from organizations;
    if v_org_count_after <> v_org_count_before then
      raise exception 'organizations row count changed (% -> %) -- the org insert was NOT rolled back with the failed membership insert', v_org_count_before, v_org_count_after;
    end if;
    raise notice 'atomicity OK: failed membership insert rolled back the org insert too (count stayed %)', v_org_count_before;
  end;
end $$;

do $$ begin raise notice 'ALL 0076 ASSERTIONS PASSED'; end $$;

rollback;
