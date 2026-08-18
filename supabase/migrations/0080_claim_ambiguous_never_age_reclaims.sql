-- Security re-audit final closure, Blocker 5 (Anton-approved decision D5,
-- 2026-08-18): "reconcile before reclaim". Round 3's own P1-5 fix made
-- CLAIM ACQUISITION fail closed on a guard RPC error, but never addressed a
-- separate failure mode in these same two RPCs: TTL-expiry reclaim reclaimed
-- 'pending', 'completed', AND 'ambiguous' claims identically, purely by
-- `created_at` age. An 'ambiguous' claim means a prior create attempt's
-- outcome with Cin7 is genuinely unknown (see markPoCreationAmbiguous/
-- markStockTransferCreationAmbiguous) -- Cin7 may have actually committed
-- the object. If nobody retries within the TTL window (a user closes the
-- tab after a network error, or genuinely returns the next day to reorder
-- the identical items), the next claim attempt got `claimed:true` directly,
-- with ZERO reconciliation -- exactly the "aged from we-don't-know into a
-- blind retry" failure mode this pass exists to close.
--
-- The app-layer reconciliation (findLikelyCreatedPurchaseOrder /
-- findLikelyCreatedStockTransfer, called from src/app/supplier-planner/
-- actions.ts and src/app/replenish/actions.ts) ALREADY runs correctly
-- whenever `existing_status = 'ambiguous'` is returned -- it was only ever
-- reachable while the claim was still live (inside the TTL window). The fix
-- is entirely in these two RPCs: an 'ambiguous' claim must keep returning
-- existing_status='ambiguous' past TTL expiry too, forcing the caller's
-- existing reconciliation branch to run every time, not just before expiry.
-- 'pending' (never attempted, or -- see the Blocker 5 app-side fix pairing
-- this migration -- now also used as the interim state until a create is
-- either genuinely attempted or the claim is settled/released) and
-- 'completed' (Cin7's outcome IS known) keep reclaiming by age exactly as
-- before -- this migration changes behavior ONLY for the 'ambiguous' case.

create or replace function public.po_creation_claim(p_org uuid, p_instance uuid, p_key text, p_ttl_seconds integer)
returns table(claimed boolean, existing_status text, cin7_purchase_id text, order_number text)
language plpgsql
as $$
declare
  v_status  text;
  v_pid     text;
  v_order   text;
  v_created timestamptz;
begin
  insert into po_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (p_org, p_instance, p_key, 'pending', clock_timestamp(), clock_timestamp())
  on conflict (org_id, instance_id, idempotency_key) do nothing;

  if found then
    return query select true, 'pending'::text, null::text, null::text;
    return;
  end if;

  select c.status, c.cin7_purchase_id, c.order_number, c.created_at
    into v_status, v_pid, v_order, v_created
  from po_creation_claims c
  where c.org_id = p_org and c.instance_id = p_instance and c.idempotency_key = p_key
  for update;

  -- Never age-reclaim an unresolved ambiguous claim -- the caller must
  -- positively reconcile against Cin7 first, regardless of how much time
  -- has passed. Checked before the TTL comparison below so it applies both
  -- inside and past the TTL window (identical to the pre-existing
  -- behavior inside the window; the fix only changes the past-TTL case).
  if v_status = 'ambiguous' then
    return query select false, v_status, v_pid, v_order;
    return;
  end if;

  if v_created > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    return query select false, v_status, v_pid, v_order;
    return;
  end if;

  update po_creation_claims
    set status = 'pending', cin7_purchase_id = null, order_number = null,
        created_at = clock_timestamp(), updated_at = clock_timestamp()
    where org_id = p_org and instance_id = p_instance and idempotency_key = p_key;
  return query select true, 'pending'::text, null::text, null::text;
end;
$$;

create or replace function public.stock_transfer_creation_claim(p_org uuid, p_instance uuid, p_key text, p_ttl_seconds integer)
returns table(claimed boolean, existing_status text, cin7_transfer_id text, transfer_number text)
language plpgsql
as $$
declare
  v_status  text;
  v_tid     text;
  v_number  text;
  v_created timestamptz;
begin
  insert into stock_transfer_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (p_org, p_instance, p_key, 'pending', clock_timestamp(), clock_timestamp())
  on conflict (org_id, instance_id, idempotency_key) do nothing;

  if found then
    return query select true, 'pending'::text, null::text, null::text;
    return;
  end if;

  select c.status, c.cin7_transfer_id, c.transfer_number, c.created_at
    into v_status, v_tid, v_number, v_created
  from stock_transfer_creation_claims c
  where c.org_id = p_org and c.instance_id = p_instance and c.idempotency_key = p_key
  for update;

  -- See po_creation_claim's identical comment above -- same fix, same reasoning.
  if v_status = 'ambiguous' then
    return query select false, v_status, v_tid, v_number;
    return;
  end if;

  if v_created > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    return query select false, v_status, v_tid, v_number;
    return;
  end if;

  update stock_transfer_creation_claims
    set status = 'pending', cin7_transfer_id = null, transfer_number = null,
        created_at = clock_timestamp(), updated_at = clock_timestamp()
    where org_id = p_org and instance_id = p_instance and idempotency_key = p_key;
  return query select true, 'pending'::text, null::text, null::text;
end;
$$;
