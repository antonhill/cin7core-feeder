-- Transactional test for migration 0057's try_acquire_sync_lock advisory
-- lock. BEGIN/ROLLBACK: safe against any DB with 0057 applied, leaves no
-- rows. Needs a real organizations + cin7_instances row (FKs); creates temp
-- ones and rolls them back. Expect it to print "ALL 0057 ... PASSED".

begin;

-- Minimal FK parents (rolled back).
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000ee', 'Sync Lock Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000ee', 'Test Instance', 'acct', 'enc');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000ee', 'Test Instance 2', 'acct2', 'enc2');

do $$
declare
  org  uuid := '00000000-0000-0000-0000-0000000000ee';
  inst uuid := '00000000-0000-0000-0000-0000000000ff';
  r1 record; r2 record; r3 record;
  first_locked_at timestamptz;
begin
  -- First acquire → granted, fresh row.
  select * into r1 from try_acquire_sync_lock(org, inst, 900);
  if not r1.acquired or r1.locked_at is null then
    raise exception 'first acquire should be granted, got acquired=% locked_at=%', r1.acquired, r1.locked_at;
  end if;
  first_locked_at := r1.locked_at;

  -- Concurrent second acquire for the SAME (org,instance) while the first is
  -- still live → blocked.
  select * into r2 from try_acquire_sync_lock(org, inst, 900);
  if r2.acquired then
    raise exception 'concurrent second acquire should be blocked, got acquired=%', r2.acquired;
  end if;
  if r2.locked_at <> first_locked_at then
    raise exception 'blocked acquire should report the live holder''s locked_at unchanged';
  end if;

  -- A DIFFERENT instance → its own fresh lock, unaffected by the first.
  select * into r3 from try_acquire_sync_lock(org, '00000000-0000-0000-0000-000000000011'::uuid, 900);
  if not r3.acquired then raise exception 'a different instance should get its own lock'; end if;

  -- Expiry: ttl=0 makes the existing lock already stale → reclaimable, and
  -- reclaiming bumps locked_at to a new value.
  select * into r1 from try_acquire_sync_lock(org, inst, 0);
  if not r1.acquired or r1.locked_at <= first_locked_at then
    raise exception 'expired lock should be reclaimable with a fresh locked_at, got acquired=% locked_at=%', r1.acquired, r1.locked_at;
  end if;

  -- Release (as the app does): delete only if locked_at still matches what
  -- we hold — simulates releaseSyncLock's optimistic-concurrency check.
  delete from sync_locks where org_id = org and instance_id = inst and locked_at = r1.locked_at;
  if not found then raise exception 'release should have deleted our own live lock row'; end if;

  -- After release, a fresh acquire succeeds immediately (no TTL wait needed).
  select * into r2 from try_acquire_sync_lock(org, inst, 900);
  if not r2.acquired then raise exception 'acquire after release should succeed immediately'; end if;
end $$;

do $$ begin raise notice 'ALL 0057 SYNC-LOCK ASSERTIONS PASSED'; end $$;

rollback;
