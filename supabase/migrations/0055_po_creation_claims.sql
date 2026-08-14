-- Phase 4.1: idempotency guard for Purchase Order creation.
--
-- createSupplierPlanPurchaseOrdersAction (and its reorder-report delegate)
-- creates a REAL Cin7 Purchase Order per group with NO pre-write idempotency —
-- loadPendingPurchaseOrders / supplier_plan_created_po_lines is only a read-time
-- UI advisory. A double-click, a second tab, or two concurrent invocations of
-- the same selection therefore create TWO real supplier POs (money / real
-- documents). This adds a short-lived, per-request claim so only ONE PO is
-- created for a given (org, instance, supplier, location, line-set) within a
-- window; a resubmit inside the window returns the already-created PO instead
-- of duplicating it. TTL-scoped so a genuine re-order of the same lines later
-- (e.g. a recurring monthly purchase) still works.
--
-- Written/read ONLY by the service-role client (bypasses RLS); RLS on, no
-- policies, EXECUTE revoked from anon/authenticated.

create table if not exists po_creation_claims (
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  -- Deterministic hash of (supplier, location, sorted lines+quantities) — see
  -- src/lib/po-idempotency.ts.
  idempotency_key  text not null,
  status           text not null default 'pending',   -- 'pending' | 'completed'
  cin7_purchase_id text,
  order_number     text,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  primary key (org_id, instance_id, idempotency_key)
);

alter table po_creation_claims enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table po_creation_claims is
  'Phase 4.1 PO-creation idempotency guard — one short-lived claim per (org,instance,line-set hash). Service-role only.';

/*
 * Atomically try to claim the right to create a PO for (p_org, p_instance,
 * p_key). Returns a single row:
 *   claimed=true  → the caller OWNS a fresh claim; it must create the PO, then
 *                   mark it completed (or delete the claim on failure).
 *   claimed=false → a LIVE (non-expired) claim already exists; the caller must
 *                   NOT create. Use existing_status:
 *                     'completed' → return the existing PO (idempotent success),
 *                     'pending'   → another request is creating it right now.
 *
 * A claim older than p_ttl_seconds is treated as expired and reclaimable, so a
 * deliberate later re-order of the same lines is allowed.
 */
create or replace function po_creation_claim(
  p_org uuid,
  p_instance uuid,
  p_key text,
  p_ttl_seconds integer
) returns table (claimed boolean, existing_status text, cin7_purchase_id text, order_number text)
language plpgsql
as $$
declare
  v_status  text;
  v_pid     text;
  v_order   text;
  v_created timestamptz;
begin
  -- Try to take a fresh claim. If no row exists this inserts and we win.
  insert into po_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (p_org, p_instance, p_key, 'pending', clock_timestamp(), clock_timestamp())
  on conflict (org_id, instance_id, idempotency_key) do nothing;

  if found then
    return query select true, 'pending'::text, null::text, null::text;
    return;
  end if;

  -- A row already exists — lock it and decide (serializes concurrent callers).
  select status, cin7_purchase_id, order_number, created_at
    into v_status, v_pid, v_order, v_created
  from po_creation_claims
  where org_id = p_org and instance_id = p_instance and idempotency_key = p_key
  for update;

  if v_created > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    -- Live claim → caller must not create.
    return query select false, v_status, v_pid, v_order;
    return;
  end if;

  -- Expired → reclaim it (we hold the row lock, so this is atomic).
  update po_creation_claims
    set status = 'pending', cin7_purchase_id = null, order_number = null,
        created_at = clock_timestamp(), updated_at = clock_timestamp()
    where org_id = p_org and instance_id = p_instance and idempotency_key = p_key;
  return query select true, 'pending'::text, null::text, null::text;
end;
$$;

revoke all on function po_creation_claim(uuid, uuid, text, integer) from public;
revoke all on function po_creation_claim(uuid, uuid, text, integer) from anon, authenticated;
