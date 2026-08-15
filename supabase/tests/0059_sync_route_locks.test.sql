-- Transactional test for migration 0059's try_acquire_sync_route_lock
-- advisory lock. BEGIN/ROLLBACK: safe against any DB with 0059 applied,
-- leaves no rows. Needs a real organizations row (FK); creates a temp one
-- and rolls it back. Expect it to print "ALL 0059 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-000000000055', 'Sync Route Lock Test Org');
insert into organizations (id, name) values ('00000000-0000-0000-0000-000000000066', 'Sync Route Lock Test Org 2');

do $$
declare
  org  uuid := '00000000-0000-0000-0000-000000000055';
  org2 uuid := '00000000-0000-0000-0000-000000000066';
  r1 record; r2 record; r3 record;
  first_locked_at timestamptz;
begin
  -- First acquire for (route,org) → granted, fresh row.
  select * into r1 from try_acquire_sync_route_lock('sync-sales', org, 900);
  if not r1.acquired or r1.locked_at is null then
    raise exception 'first acquire should be granted, got acquired=% locked_at=%', r1.acquired, r1.locked_at;
  end if;
  first_locked_at := r1.locked_at;

  -- Concurrent second acquire for the SAME (route,org) while live → blocked.
  select * into r2 from try_acquire_sync_route_lock('sync-sales', org, 900);
  if r2.acquired then raise exception 'concurrent second acquire should be blocked, got acquired=%', r2.acquired; end if;
  if r2.locked_at <> first_locked_at then raise exception 'blocked acquire should report the live holder''s locked_at unchanged'; end if;

  -- A DIFFERENT route for the SAME org → its own fresh lock, unaffected.
  select * into r3 from try_acquire_sync_route_lock('sync-purchases', org, 900);
  if not r3.acquired then raise exception 'a different route should get its own lock'; end if;

  -- The SAME route for a DIFFERENT org → its own fresh lock, unaffected.
  select * into r3 from try_acquire_sync_route_lock('sync-sales', org2, 900);
  if not r3.acquired then raise exception 'a different org should get its own lock'; end if;

  -- Expiry: ttl=0 makes the existing lock already stale → reclaimable with a fresh locked_at.
  select * into r1 from try_acquire_sync_route_lock('sync-sales', org, 0);
  if not r1.acquired or r1.locked_at <= first_locked_at then
    raise exception 'expired lock should be reclaimable with a fresh locked_at, got acquired=% locked_at=%', r1.acquired, r1.locked_at;
  end if;

  -- Release (as the app does): delete only if locked_at still matches.
  delete from sync_route_locks where sync_route = 'sync-sales' and org_id = org and locked_at = r1.locked_at;
  if not found then raise exception 'release should have deleted our own live lock row'; end if;

  -- After release, a fresh acquire succeeds immediately.
  select * into r2 from try_acquire_sync_route_lock('sync-sales', org, 900);
  if not r2.acquired then raise exception 'acquire after release should succeed immediately'; end if;
end $$;

do $$ begin raise notice 'ALL 0059 SYNC-ROUTE-LOCK ASSERTIONS PASSED'; end $$;

rollback;
