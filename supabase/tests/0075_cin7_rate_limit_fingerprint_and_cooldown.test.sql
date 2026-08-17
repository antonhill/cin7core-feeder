-- Transactional test for migration 0075's bucket_key rekey + shared cooldown.
-- Wrapped in BEGIN/ROLLBACK: safe to run against any DB that has 0075 applied —
-- it leaves no rows behind. Expect it to print "ALL 0075 ... PASSED".
--
-- Migration 0054's own test (0054_cin7_rate_limit.test.sql) still applies
-- unchanged for the core token-bucket math (burst/throttle/independent
-- buckets/invalid params) — the key column was renamed (account_id ->
-- bucket_key) but bound positionally, so that test still exercises the same
-- function correctly. This file covers ONLY what's new in 0075.

begin;

do $$
declare
  w1 double precision;
  w2 double precision;
  w3 double precision;
  w4 double precision;
  w_cooldown double precision;
begin
  -- Burst then throttle still works on the renamed bucket_key column.
  w1 := cin7_rate_limit_acquire('test-fingerprint-1', 3, 1);
  w2 := cin7_rate_limit_acquire('test-fingerprint-1', 3, 1);
  w3 := cin7_rate_limit_acquire('test-fingerprint-1', 3, 1);
  w4 := cin7_rate_limit_acquire('test-fingerprint-1', 3, 1);
  if w1 <> 0 or w2 <> 0 or w3 <> 0 then
    raise exception 'expected first 3 acquires granted, got %, %, %', w1, w2, w3;
  end if;
  if w4 <= 0 or w4 > 1000 then
    raise exception 'expected 4th acquire to wait in (0,1000]ms, got %', w4;
  end if;
  raise notice 'burst+throttle OK (4th wait = % ms)', w4;

  -- report_cooldown blocks acquire for roughly that long, regardless of
  -- available tokens (a fresh bucket would otherwise be granted immediately).
  perform cin7_rate_limit_report_cooldown('test-fingerprint-2', 5000);
  w_cooldown := cin7_rate_limit_acquire('test-fingerprint-2', 5, 1);
  if w_cooldown < 4000 or w_cooldown > 5000 then
    raise exception 'expected acquire to report the cooldown window (~5000ms), got %', w_cooldown;
  end if;
  raise notice 'cooldown OK (wait = % ms)', w_cooldown;

  -- A second, SHORTER cooldown report must not shorten the existing longer one.
  perform cin7_rate_limit_report_cooldown('test-fingerprint-2', 1000);
  w_cooldown := cin7_rate_limit_acquire('test-fingerprint-2', 5, 1);
  if w_cooldown < 3000 then
    raise exception 'a shorter cooldown report must not shorten the existing longer one, got %', w_cooldown;
  end if;
  raise notice 'cooldown-extend-only OK (wait = % ms)', w_cooldown;

  -- Independent buckets: a different key starts with its own full bucket,
  -- unaffected by another bucket's cooldown.
  if cin7_rate_limit_acquire('test-fingerprint-3', 3, 1) <> 0 then
    raise exception 'a fresh bucket should be granted immediately';
  end if;
end $$;

do $$ begin raise notice 'ALL 0075 RATE-LIMIT ASSERTIONS PASSED'; end $$;

rollback;
