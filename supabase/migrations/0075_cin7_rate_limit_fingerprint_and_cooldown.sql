-- Phase 2.1 follow-up (security re-audit P0-3): correct two design gaps in
-- the distributed Cin7 rate limiter found on re-audit.
--
-- 1. Bucket identity: was keyed by Cin7 accountId alone. Cin7's 60/min limit
--    is actually per API APPLICATION — an account can have more than one
--    Application (API key) configured, each with its own independent 60/min
--    budget — so keying by accountId alone could wrongly SHARE one bucket
--    across two distinct applications on the same account. Re-keyed to a
--    fingerprint of (accountId, applicationKey): a stable, non-reversible
--    SHA-256 hash computed in src/cin7/rate-limit.ts — never the raw
--    applicationKey itself, which must never land in a table an ops tool
--    might casually browse.
-- 2. Shared cooldown: a real Cin7 503 (Cin7's own authoritative "you're over
--    budget" signal) used to only inform the ONE invocation that hit it —
--    every other concurrent invocation sharing this bucket kept sending at
--    the normal pace until it independently discovered the same 503.
--    cin7_rate_limit_report_cooldown lets any caller that sees a 503 push a
--    shared cooldown into the bucket, so every other invocation coordinating
--    through it backs off immediately too.
--
-- Table recreated rather than ALTERed/data-migrated: it holds only
-- continuously-refreshed, ephemeral pacing state (no historical value), so a
-- fresh bucket under the new key scheme just starts full — a safe, harmless
-- cold start, not a data-loss concern.

drop function if exists cin7_rate_limit_acquire(text, double precision, double precision);
drop table if exists cin7_rate_limits;

create table cin7_rate_limits (
  -- sha256(accountId || ':' || applicationKey) — see rate-limit.ts's
  -- cin7RateLimitBucketKey. Never the raw credential.
  bucket_key    text primary key,
  -- Current available tokens (fractional — refills continuously over time).
  tokens        double precision not null,
  -- Wall-clock time the bucket was last refilled/consumed.
  updated_at    timestamptz not null default clock_timestamp(),
  -- Set by cin7_rate_limit_report_cooldown after a real Cin7 503. While in
  -- the future, cin7_rate_limit_acquire refuses a token regardless of
  -- available tokens — every invocation sharing this bucket backs off
  -- together instead of each independently re-discovering the same 503.
  blocked_until timestamptz
);

alter table cin7_rate_limits enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table cin7_rate_limits is
  'Security re-audit P0-3 — Cin7 distributed rate limiter, one token-bucket row per (accountId, applicationKey) fingerprint. Service-role only.';

/*
 * Atomically try to take one token from the bucket for p_bucket_key.
 * Returns the number of MILLISECONDS the caller must wait: 0 means a token
 * was granted (proceed now); > 0 means none was available (sleep that long,
 * then call again) — including the entire remaining cooldown window when
 * blocked_until is still in the future, overriding normal token accounting.
 *
 * The row is locked FOR UPDATE so concurrent serverless invocations
 * acquiring against the same bucket serialize correctly. Refill is
 * time-based (clock_timestamp — real wall clock), capped at p_capacity. A
 * brand-new bucket starts full, so the first call for a bucket is granted
 * (unless a cooldown is already in effect).
 */
create or replace function cin7_rate_limit_acquire(
  p_bucket_key text,
  p_capacity double precision,
  p_refill_per_sec double precision
) returns double precision
language plpgsql
as $$
declare
  v_tokens        double precision;
  v_updated       timestamptz;
  v_blocked_until timestamptz;
  v_now           timestamptz := clock_timestamp();
  v_elapsed       double precision;
begin
  if p_refill_per_sec <= 0 or p_capacity < 1 then
    raise exception 'cin7_rate_limit_acquire: capacity must be >= 1 and refill_per_sec > 0';
  end if;

  insert into cin7_rate_limits (bucket_key, tokens, updated_at)
  values (p_bucket_key, p_capacity, v_now)
  on conflict (bucket_key) do nothing;

  select tokens, updated_at, blocked_until into v_tokens, v_updated, v_blocked_until
  from cin7_rate_limits
  where bucket_key = p_bucket_key
  for update;

  -- A shared cooldown reported after a real Cin7 503 overrides normal token
  -- accounting entirely — every caller waits it out together.
  if v_blocked_until is not null and v_blocked_until > v_now then
    return ceil(extract(epoch from (v_blocked_until - v_now)) * 1000);
  end if;

  v_elapsed := extract(epoch from (v_now - v_updated));
  v_tokens  := least(p_capacity, v_tokens + v_elapsed * p_refill_per_sec);

  if v_tokens >= 1 then
    update cin7_rate_limits
      set tokens = v_tokens - 1, updated_at = v_now
      where bucket_key = p_bucket_key;
    return 0;
  end if;

  update cin7_rate_limits
    set tokens = v_tokens, updated_at = v_now
    where bucket_key = p_bucket_key;
  return ceil(((1 - v_tokens) / p_refill_per_sec) * 1000);
end;
$$;

revoke all on function cin7_rate_limit_acquire(text, double precision, double precision) from public;
revoke all on function cin7_rate_limit_acquire(text, double precision, double precision) from anon, authenticated;

/*
 * Called after a real Cin7 503 (or the /purchase-family's non-standard
 * "reached 60 calls per 60 seconds" 200-with-message variant — see
 * src/cin7/http.ts) to push a shared cooldown into this bucket, so every
 * OTHER invocation coordinating through it backs off immediately too,
 * instead of each independently colliding with the same limit and
 * discovering it on its own. Extends an existing cooldown rather than
 * shortening it (GREATEST), so an overlapping report from a second caller
 * can't accidentally cut the window short.
 */
create or replace function cin7_rate_limit_report_cooldown(
  p_bucket_key text,
  p_cooldown_ms integer
) returns void
language plpgsql
as $$
begin
  insert into cin7_rate_limits (bucket_key, tokens, updated_at, blocked_until)
  values (p_bucket_key, 0, clock_timestamp(), clock_timestamp() + make_interval(secs => p_cooldown_ms / 1000.0))
  on conflict (bucket_key) do update
    set tokens = 0,
        blocked_until = greatest(
          coalesce(cin7_rate_limits.blocked_until, clock_timestamp()),
          clock_timestamp() + make_interval(secs => p_cooldown_ms / 1000.0)
        );
end;
$$;

revoke all on function cin7_rate_limit_report_cooldown(text, integer) from public;
revoke all on function cin7_rate_limit_report_cooldown(text, integer) from anon, authenticated;
