-- Phase 3.3a: per-(org,route) in-flight guard to stop overlapping cron
-- ticks / user syncs double-scanning.
--
-- Every sync engine (sync-org.ts's syncOrgInstances, sync-sales.ts's
-- syncOrgSales, and the same shape in sync-purchases/sync-assembly-builds/
-- sync-product-availability/sync-production-runs) is reachable from at
-- least three places for the SAME org: its own 15-min cron tick (via
-- cron-rotation.ts), its route's on-demand `POST /api/sync*`, and — for
-- several of them — a direct action call from a report page's own "sync
-- now" button (e.g. src/app/replenish/actions.ts, src/app/reports/
-- stock-health/actions.ts). Two overlapping runs for the same (org, route)
-- both re-query and re-walk that org's whole instance list — wasted Cin7
-- API calls and DB round trips, not (for most of these) a data-integrity
-- risk the way Phase 4's unguarded create-paths were (this table only
-- guards AGAINST STARTING a redundant scan; Phase 4.3's separate
-- sync_locks already guards the "sync" route's own per-instance writes
-- against actual duplication).
--
-- Same INSERT-or-reclaim shape as migration 0057's try_acquire_sync_lock —
-- see that migration's comment for why a real Postgres advisory lock
-- doesn't fit this architecture (PostgREST's stateless, pooled-connection
-- HTTP calls). Keyed (sync_route, org_id) to match the existing
-- sync_route_attempts table's own column order/shape (0040) — a sibling
-- table for the same rotation machinery, but a genuine mutual-exclusion
-- lock rather than fairness-ordering bookkeeping, so kept separate rather
-- than repurposing sync_route_attempts.last_attempted_at (which already
-- has its own distinct meaning: "when did we last finish attempting this
-- org").
--
-- Written/read ONLY by the service-role client (bypasses RLS); RLS on, no
-- policies, EXECUTE revoked from anon/authenticated.

create table if not exists sync_route_locks (
  sync_route text not null,
  org_id     uuid not null references organizations (id) on delete cascade,
  locked_at  timestamptz not null default clock_timestamp(),
  primary key (sync_route, org_id)
);

alter table sync_route_locks enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table sync_route_locks is
  'Phase 3.3a per-(org,route) sync advisory lock — short-lived, stale-TTL-reclaimable. Service-role only.';

/*
 * Atomically try to acquire the lock for (p_route, p_org). Returns a single
 * row:
 *   acquired=true  → the caller OWNS the lock (fresh or reclaimed from a
 *                     stale holder) as of locked_at; it must release it
 *                     (releaseSyncRouteLock, src/lib/sync-route-lock.ts)
 *                     when done, passing this exact locked_at back so a
 *                     release can't ever clear a DIFFERENT holder's lock
 *                     reclaimed after ours expired.
 *   acquired=false → a LIVE (non-expired) lock is already held by another
 *                     run; the caller must skip this org+route entirely
 *                     this attempt.
 *
 * A lock older than p_ttl_seconds is treated as abandoned and reclaimable.
 */
create or replace function try_acquire_sync_route_lock(
  p_route text,
  p_org uuid,
  p_ttl_seconds integer
) returns table (acquired boolean, locked_at timestamptz)
language plpgsql
as $$
declare
  v_locked_at timestamptz;
  v_new_locked_at timestamptz;
begin
  insert into sync_route_locks (sync_route, org_id, locked_at)
  values (p_route, p_org, clock_timestamp())
  on conflict (sync_route, org_id) do nothing
  returning sync_route_locks.locked_at into v_new_locked_at;

  if found then
    return query select true, v_new_locked_at;
    return;
  end if;

  select s.locked_at into v_locked_at
  from sync_route_locks s
  where s.sync_route = p_route and s.org_id = p_org
  for update;

  if v_locked_at > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    return query select false, v_locked_at;
    return;
  end if;

  update sync_route_locks set locked_at = clock_timestamp()
    where sync_route = p_route and org_id = p_org
    returning sync_route_locks.locked_at into v_new_locked_at;
  return query select true, v_new_locked_at;
end;
$$;

revoke all on function try_acquire_sync_route_lock(text, uuid, integer) from public;
revoke all on function try_acquire_sync_route_lock(text, uuid, integer) from anon, authenticated;
