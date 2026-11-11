-- Purchase detail freshness: a prioritised refresh queue + an atomic newer-wins replace.
-- NO table or column changes — two functions only. Reversible with two DROP FUNCTION statements.
--
-- WHY A SQL FUNCTION (vs an application-level queue)
--   The queue is "unsynced OR relisted-after-fetch (updated_at > detail_synced_at) OR open and past its
--   TTL". The middle condition compares two COLUMNS of the same row, which PostgREST cannot express, so the
--   only application-level alternative is to page EVERY purchase header of an instance (≈11.6k rows,
--   ~12 requests, ~1.5 MB) on each 15-minute cycle (≈150 MB/day/instance) and filter in JavaScript — slower,
--   racier (the snapshot is stale by the time it is acted on) and it duplicates the priority logic in a
--   place the SQL tests cannot reach. The function is read-only, org+instance scoped, runs in milliseconds
--   on the existing primary-key prefix, and needs no new index. The application falls back to the legacy
--   "unsynced only" selection if the function is absent, so code and migration can deploy in either order.
--
-- WHY A GUARDED REPLACE
--   "An older fetch must never overwrite newer detail" cannot be enforced atomically from the application:
--   it needs the purchases row lock. replace_purchase_detail_guarded locks the row FOR UPDATE, skips when a
--   newer detail was already applied, and otherwise delegates to the unchanged replace_purchase_detail (0074).
--
-- ROLLBACK: drop function replace_purchase_detail_guarded(uuid, uuid, text, jsonb, jsonb, text, boolean, timestamptz);
--           drop function purchase_refresh_queue(uuid, uuid, integer, integer);
--   (the application then uses its legacy path; no data is affected.)

create or replace function purchase_refresh_queue(
  p_org_id uuid,
  p_instance_id uuid,
  p_open_ttl_hours integer default 24,
  p_limit integer default 60
)
returns table (
  cin7_purchase_id text,
  order_number text,
  source text,
  combined_receiving_status text,
  reason text,
  -- When Toolbox last saw the PO relisted. The application compares it with a "suspected void" record so a longer
  -- backoff can never hide a source-confirmed change (a relist after the suspicion bypasses it).
  updated_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with c as (
    select
      p.cin7_purchase_id,
      p.order_number,
      p.source,
      p.combined_receiving_status,
      p.order_date,
      p.detail_synced_at,
      p.updated_at,
      case
        when p.detail_synced_at is null then 'unsynced'
        when p.updated_at > p.detail_synced_at + interval '1 second' then 'relisted'
        else 'open_ttl'
      end as reason,
      (p.combined_receiving_status in ('NOT RECEIVED', 'PARTIALLY RECEIVED')) as is_open
    from purchases p
    where p.org_id = p_org_id
      and p.instance_id = p_instance_id
      and coalesce(p.status, '') <> 'VOIDED'
      and (
        p.detail_synced_at is null
        or p.updated_at > p.detail_synced_at + interval '1 second'
        or (
          p.combined_receiving_status in ('NOT RECEIVED', 'PARTIALLY RECEIVED')
          and p.detail_synced_at < now() - make_interval(hours => greatest(p_open_ttl_hours, 1))
        )
      )
  )
  select c.cin7_purchase_id, c.order_number, c.source, c.combined_receiving_status, c.reason, c.updated_at
  from c
  order by
    -- tier 0: never synced (today's behaviour, first); tier 1: open POs (relisted or past TTL); tier 2: closed relisted
    case when c.reason = 'unsynced' then 0 when c.is_open then 1 else 2 end,
    -- partially received first: receiving is still moving
    case when c.combined_receiving_status = 'PARTIALLY RECEIVED' then 0 else 1 end,
    -- open tier: least-recently-verified first, so the TTL rotation is fair; other tiers fall through to recency
    case when c.reason <> 'unsynced' and c.is_open then c.detail_synced_at end asc nulls last,
    c.order_date desc nulls last,
    c.cin7_purchase_id
  limit greatest(p_limit, 0)
$$;

comment on function purchase_refresh_queue(uuid, uuid, integer, integer) is
  'Read-only, org+instance scoped. Purchases needing a detail refresh: never synced, relisted after their last detail fetch (updated_at > detail_synced_at), or open (NOT/PARTIALLY RECEIVED) and not verified within p_open_ttl_hours. VOIDED excluded. Priority: unsynced, open (partial first, least recently verified first), closed relisted (newest order first).';

create or replace function replace_purchase_detail_guarded(
  p_org_id uuid,
  p_instance_id uuid,
  p_cin7_purchase_id text,
  p_receipt_lines jsonb,
  p_order_lines jsonb,
  p_source text,
  p_is_drop_ship boolean,
  p_fetched_at timestamptz
)
returns boolean
language plpgsql
set search_path = public
as $$
declare
  v_synced timestamptz;
begin
  -- Serialises concurrent replacements of the SAME purchase and gives us a consistent read of detail_synced_at.
  select pu.detail_synced_at into v_synced
  from purchases pu
  where pu.org_id = p_org_id and pu.instance_id = p_instance_id and pu.cin7_purchase_id = p_cin7_purchase_id
  for update;

  if not found then
    return false;
  end if;

  -- A detail newer than this fetch's start was applied meanwhile: do not overwrite it with older data.
  if v_synced is not null and v_synced > p_fetched_at then
    return false;
  end if;

  perform replace_purchase_detail(p_org_id, p_instance_id, p_cin7_purchase_id, p_receipt_lines, p_order_lines, p_source, p_is_drop_ship);
  return true;
end;
$$;

comment on function replace_purchase_detail_guarded(uuid, uuid, text, jsonb, jsonb, text, boolean, timestamptz) is
  'Atomic newer-wins wrapper around replace_purchase_detail (0074): locks the purchase row, returns false (changing nothing) when the purchase is missing or a detail newer than p_fetched_at is already stored, otherwise replaces atomically and returns true.';

revoke all on function purchase_refresh_queue(uuid, uuid, integer, integer) from public;
revoke all on function purchase_refresh_queue(uuid, uuid, integer, integer) from anon, authenticated;
revoke all on function replace_purchase_detail_guarded(uuid, uuid, text, jsonb, jsonb, text, boolean, timestamptz) from public;
revoke all on function replace_purchase_detail_guarded(uuid, uuid, text, jsonb, jsonb, text, boolean, timestamptz) from anon, authenticated;
