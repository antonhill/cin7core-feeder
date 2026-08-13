-- Phase 2.1: distributed Cin7 rate limiter (Postgres token bucket).
--
-- Cin7 Core enforces 60 calls/min PER API APPLICATION, keyed by accountId, and
-- returns 503 (no Retry-After) when exceeded. The app's existing throttle
-- (src/cin7/http.ts) only paces calls WITHIN one serverless invocation, so
-- concurrent Vercel invocations (6 cron sync routes fire on the same 15-min
-- schedule, plus on-demand syncs, live Supplier-Planner reports, and
-- migrate/import jobs) can all hit the same account at once and blow past
-- 60/min from combined volume. This is the cross-invocation coordination the
-- http.ts comment has been asking for.
--
-- A classic token bucket, keyed by accountId, stored in Postgres so every
-- serverless invocation shares one budget. Written/read ONLY by the app's
-- service-role client (which bypasses RLS); RLS is enabled with no policies and
-- EXECUTE is revoked from anon/authenticated so a raw session can neither read
-- the table nor call the acquire function.

create table if not exists cin7_rate_limits (
  account_id text primary key,
  -- Current available tokens (fractional — refills continuously over time).
  tokens double precision not null,
  -- Wall-clock time the bucket was last refilled/consumed.
  updated_at timestamptz not null default clock_timestamp()
);

alter table cin7_rate_limits enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table cin7_rate_limits is
  'Phase 2.1 distributed Cin7 rate limiter — one token-bucket row per Cin7 accountId. Service-role only.';

/*
 * Atomically try to take one token from the bucket for p_account_id.
 * Returns the number of MILLISECONDS the caller must wait: 0 means a token was
 * granted (proceed now); > 0 means none was available (sleep that long, then
 * call again).
 *
 * The row is locked FOR UPDATE so concurrent serverless invocations acquiring
 * against the same account serialize correctly. Refill is time-based
 * (clock_timestamp — real wall clock, NOT now()/transaction_timestamp which is
 * frozen at BEGIN), capped at p_capacity (the burst allowance). A brand-new
 * bucket starts full, so the first call for an account is always granted.
 */
create or replace function cin7_rate_limit_acquire(
  p_account_id text,
  p_capacity double precision,
  p_refill_per_sec double precision
) returns double precision
language plpgsql
as $$
declare
  v_tokens  double precision;
  v_updated timestamptz;
  v_now     timestamptz := clock_timestamp();
  v_elapsed double precision;
begin
  if p_refill_per_sec <= 0 or p_capacity < 1 then
    raise exception 'cin7_rate_limit_acquire: capacity must be >= 1 and refill_per_sec > 0';
  end if;

  -- Make sure a bucket row exists (starts full). Atomic and race-safe: if a
  -- concurrent transaction already created it, this is a no-op.
  insert into cin7_rate_limits (account_id, tokens, updated_at)
  values (p_account_id, p_capacity, v_now)
  on conflict (account_id) do nothing;

  -- Lock the row and read current state (it definitely exists now).
  select tokens, updated_at into v_tokens, v_updated
  from cin7_rate_limits
  where account_id = p_account_id
  for update;

  -- Time-based refill, capped at capacity.
  v_elapsed := extract(epoch from (v_now - v_updated));
  v_tokens  := least(p_capacity, v_tokens + v_elapsed * p_refill_per_sec);

  if v_tokens >= 1 then
    update cin7_rate_limits
      set tokens = v_tokens - 1, updated_at = v_now
      where account_id = p_account_id;
    return 0;
  end if;

  -- Not enough: persist the refill, tell the caller how long until 1 token.
  update cin7_rate_limits
    set tokens = v_tokens, updated_at = v_now
    where account_id = p_account_id;
  return ceil(((1 - v_tokens) / p_refill_per_sec) * 1000);
end;
$$;

-- Lock the function down to the service-role path only.
revoke all on function cin7_rate_limit_acquire(text, double precision, double precision) from public;
revoke all on function cin7_rate_limit_acquire(text, double precision, double precision) from anon, authenticated;
