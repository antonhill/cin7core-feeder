-- Transactional test for migration 0054's cin7_rate_limit_acquire token bucket.
-- Wrapped in BEGIN/ROLLBACK: safe to run against any DB that has 0054 applied —
-- it leaves no rows behind. Expect it to print "ALL 0054 ... PASSED".

begin;

-- Burst then throttle: capacity 3, refill 1 token/sec. The first 3 acquires for
-- an account should be granted immediately (return 0); the 4th, with the bucket
-- drained and only microseconds elapsed, must return a positive wait (~1000ms).
do $$
declare
  w1 double precision;
  w2 double precision;
  w3 double precision;
  w4 double precision;
begin
  w1 := cin7_rate_limit_acquire('test-acct', 3, 1);
  w2 := cin7_rate_limit_acquire('test-acct', 3, 1);
  w3 := cin7_rate_limit_acquire('test-acct', 3, 1);
  w4 := cin7_rate_limit_acquire('test-acct', 3, 1);
  if w1 <> 0 or w2 <> 0 or w3 <> 0 then
    raise exception 'expected first 3 acquires granted (0), got %, %, %', w1, w2, w3;
  end if;
  if w4 <= 0 or w4 > 1000 then
    raise exception 'expected 4th acquire to wait in (0, 1000]ms, got %', w4;
  end if;
  raise notice 'burst+throttle OK (4th wait = % ms)', w4;
end $$;

-- Independent budgets: a different account starts with its own full bucket.
do $$
declare w double precision;
begin
  w := cin7_rate_limit_acquire('other-acct', 3, 1);
  if w <> 0 then
    raise exception 'a fresh account should be granted immediately, got %', w;
  end if;
end $$;

-- Invalid parameters are rejected.
do $$
begin
  begin
    perform cin7_rate_limit_acquire('x', 0, 1);
    raise exception 'expected capacity < 1 to raise';
  exception when others then
    if sqlerrm not like '%capacity must be >= 1%' then raise; end if;
  end;

  begin
    perform cin7_rate_limit_acquire('x', 5, 0);
    raise exception 'expected refill_per_sec <= 0 to raise';
  exception when others then
    if sqlerrm not like '%refill_per_sec > 0%' then raise; end if;
  end;
end $$;

do $$ begin raise notice 'ALL 0054 RATE-LIMIT ASSERTIONS PASSED'; end $$;

rollback;
