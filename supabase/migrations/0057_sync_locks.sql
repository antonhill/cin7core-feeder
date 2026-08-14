-- Phase 4.3: per-(org,instance) advisory lock around syncs.
--
-- Phase 4's audit found the product/customer/supplier push sync
-- (syncOrgInstances → syncInstance, src/sync/run-sync.ts) has three real call
-- sites that can race for the SAME (org, instance): the 15-min cron tick
-- (`GET /api/sync`), an on-demand trigger (`POST /api/sync`), and the Import
-- wizard's "push to Cin7" button (`pushToCin7Action`). Concurrent runs mostly
-- self-heal (idempotent upsert + content_hash skip-if-unchanged), but can
-- still double-scan the whole catalog and race on the same row's
-- synced_hash write. This is a true mutual-exclusion lock, not a create-once
-- memo like migrations 0055/0056 — "advisory" in the sense that a stuck lock
-- (crashed process, Vercel's 300s hard timeout) is reclaimable after a TTL
-- comfortably longer than that ceiling, not that it's optional to respect.
--
-- Written/read ONLY by the service-role client (bypasses RLS); RLS on, no
-- policies, EXECUTE revoked from anon/authenticated.

create table if not exists sync_locks (
  org_id      uuid not null references organizations (id) on delete cascade,
  instance_id uuid not null references cin7_instances (id) on delete cascade,
  locked_at   timestamptz not null default clock_timestamp(),
  primary key (org_id, instance_id)
);

alter table sync_locks enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table sync_locks is
  'Phase 4.3 per-(org,instance) sync advisory lock — short-lived, stale-TTL-reclaimable. Service-role only.';

/*
 * Atomically try to acquire the lock for (p_org, p_instance). Returns a
 * single row:
 *   acquired=true  → the caller OWNS the lock (fresh or reclaimed from a
 *                     stale holder) as of locked_at; it must release it
 *                     (releaseSyncLock, src/lib/sync-lock.ts) when done,
 *                     passing this exact locked_at back so a release can't
 *                     ever clear a DIFFERENT holder's lock reclaimed after
 *                     ours expired.
 *   acquired=false → a LIVE (non-expired) lock is already held by another
 *                     sync run; the caller must skip this instance entirely
 *                     this attempt (the next cron tick / manual retry picks
 *                     it up once free).
 *
 * A lock older than p_ttl_seconds is treated as abandoned and reclaimable.
 */
create or replace function try_acquire_sync_lock(
  p_org uuid,
  p_instance uuid,
  p_ttl_seconds integer
) returns table (acquired boolean, locked_at timestamptz)
language plpgsql
as $$
declare
  v_locked_at timestamptz;
  v_new_locked_at timestamptz;
begin
  insert into sync_locks (org_id, instance_id, locked_at)
  values (p_org, p_instance, clock_timestamp())
  on conflict (org_id, instance_id) do nothing
  returning sync_locks.locked_at into v_new_locked_at;

  if found then
    return query select true, v_new_locked_at;
    return;
  end if;

  -- A row already exists — lock it and decide (serializes concurrent callers).
  select s.locked_at into v_locked_at
  from sync_locks s
  where s.org_id = p_org and s.instance_id = p_instance
  for update;

  if v_locked_at > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    -- Live lock held by someone else → caller must skip.
    return query select false, v_locked_at;
    return;
  end if;

  -- Expired → reclaim it (we hold the row lock, so this is atomic).
  update sync_locks set locked_at = clock_timestamp()
    where org_id = p_org and instance_id = p_instance
    returning sync_locks.locked_at into v_new_locked_at;
  return query select true, v_new_locked_at;
end;
$$;

revoke all on function try_acquire_sync_lock(uuid, uuid, integer) from public;
revoke all on function try_acquire_sync_lock(uuid, uuid, integer) from anon, authenticated;
