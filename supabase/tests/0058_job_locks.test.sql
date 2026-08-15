-- Transactional test for migration 0058's job-chunk claim column. Unlike
-- 0055-0057 there's no PL/pgSQL function to call — the "claiming UPDATE" is
-- issued directly (see src/lib/job-lock.ts), so this test exercises that
-- exact UPDATE ... WHERE shape against a real push_jobs row.
-- BEGIN/ROLLBACK: safe against any DB with 0058 applied, leaves no rows.
-- Expect it to print "ALL 0058 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-000000000022', 'Job Lock Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-000000000022', 'Test Instance', 'acct', 'enc');
insert into push_jobs (id, org_id, instance_ids, scope)
  values ('00000000-0000-0000-0000-000000000044', '00000000-0000-0000-0000-000000000022', array['00000000-0000-0000-0000-000000000033']::uuid[], '{}'::jsonb);

do $$
declare
  job uuid := '00000000-0000-0000-0000-000000000044';
  claimed_count int;
  first_locked_at timestamptz;
begin
  -- First claim (locked_at IS NULL) → succeeds.
  update push_jobs set locked_at = clock_timestamp()
    where id = job and (locked_at is null or locked_at < clock_timestamp() - make_interval(secs => 360));
  get diagnostics claimed_count = row_count;
  if claimed_count <> 1 then raise exception 'first claim should affect exactly 1 row, got %', claimed_count; end if;

  select locked_at into first_locked_at from push_jobs where id = job;
  if first_locked_at is null then raise exception 'locked_at should be set after claiming'; end if;

  -- Concurrent second claim attempt while the lock is still live → affects 0 rows.
  update push_jobs set locked_at = clock_timestamp()
    where id = job and (locked_at is null or locked_at < clock_timestamp() - make_interval(secs => 360));
  get diagnostics claimed_count = row_count;
  if claimed_count <> 0 then raise exception 'concurrent claim while live should affect 0 rows, got %', claimed_count; end if;

  -- locked_at is unchanged by the failed claim attempt.
  if (select locked_at from push_jobs where id = job) <> first_locked_at then
    raise exception 'a failed claim must not have changed locked_at';
  end if;

  -- Release (as the app does): clear locked_at.
  update push_jobs set locked_at = null where id = job;
  if (select locked_at from push_jobs where id = job) is not null then
    raise exception 'release should have cleared locked_at';
  end if;

  -- After release, a fresh claim succeeds immediately.
  update push_jobs set locked_at = clock_timestamp()
    where id = job and (locked_at is null or locked_at < clock_timestamp() - make_interval(secs => 360));
  get diagnostics claimed_count = row_count;
  if claimed_count <> 1 then raise exception 'claim after release should succeed, got %', claimed_count; end if;

  -- Expiry: a claim older than the TTL is reclaimable — ttl=0 makes the
  -- current lock already stale.
  update push_jobs set locked_at = clock_timestamp()
    where id = job and (locked_at is null or locked_at < clock_timestamp() - make_interval(secs => 0));
  get diagnostics claimed_count = row_count;
  if claimed_count <> 1 then raise exception 'expired claim should be reclaimable, got %', claimed_count; end if;
end $$;

do $$ begin raise notice 'ALL 0058 JOB-LOCK ASSERTIONS PASSED'; end $$;

rollback;
