-- Phase 4.2: idempotency guard for Stock Transfer creation.
--
-- createReplenishTransfersAction creates a REAL Cin7 Stock Transfer per
-- destination group with NO pre-write idempotency — a double-click, a second
-- tab, or two concurrent invocations of the same replenish selection
-- therefore create TWO real stock transfers moving the same stock twice.
-- Same shape as migration 0055's PO-creation guard: a short-lived, per-request
-- claim so only ONE transfer is created for a given (org, instance, from
-- location, to location, line-set) within a window; a resubmit inside the
-- window returns the already-created transfer instead of duplicating it.
-- TTL-scoped so a genuine later replenish of the same lines still works.
--
-- Written/read ONLY by the service-role client (bypasses RLS); RLS on, no
-- policies, EXECUTE revoked from anon/authenticated.

create table if not exists stock_transfer_creation_claims (
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  -- Deterministic hash of (fromLocation, toLocation, sorted lines+quantities)
  -- — see src/lib/stock-transfer-idempotency.ts.
  idempotency_key  text not null,
  status           text not null default 'pending',   -- 'pending' | 'completed'
  cin7_transfer_id text,
  transfer_number  text,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  primary key (org_id, instance_id, idempotency_key)
);

alter table stock_transfer_creation_claims enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table stock_transfer_creation_claims is
  'Phase 4.2 Stock-Transfer-creation idempotency guard — one short-lived claim per (org,instance,line-set hash). Service-role only.';

/*
 * Atomically try to claim the right to create a Stock Transfer for
 * (p_org, p_instance, p_key). Returns a single row:
 *   claimed=true  → the caller OWNS a fresh claim; it must create the
 *                   transfer, then mark it completed (or delete the claim on
 *                   failure).
 *   claimed=false → a LIVE (non-expired) claim already exists; the caller
 *                   must NOT create. Use existing_status:
 *                     'completed' → return the existing transfer (idempotent
 *                                   success),
 *                     'pending'   → another request is creating it right now.
 *
 * A claim older than p_ttl_seconds is treated as expired and reclaimable, so
 * a deliberate later replenish of the same lines is allowed.
 */
create or replace function stock_transfer_creation_claim(
  p_org uuid,
  p_instance uuid,
  p_key text,
  p_ttl_seconds integer
) returns table (claimed boolean, existing_status text, cin7_transfer_id text, transfer_number text)
language plpgsql
as $$
declare
  v_status  text;
  v_tid     text;
  v_number  text;
  v_created timestamptz;
begin
  -- Try to take a fresh claim. If no row exists this inserts and we win.
  insert into stock_transfer_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (p_org, p_instance, p_key, 'pending', clock_timestamp(), clock_timestamp())
  on conflict (org_id, instance_id, idempotency_key) do nothing;

  if found then
    return query select true, 'pending'::text, null::text, null::text;
    return;
  end if;

  -- A row already exists — lock it and decide (serializes concurrent callers).
  -- Columns are table-qualified: the RETURNS TABLE output params share the
  -- names cin7_transfer_id / transfer_number, so an unqualified select is
  -- ambiguous (same fix already applied to po_creation_claim in 0055's
  -- follow-up).
  select c.status, c.cin7_transfer_id, c.transfer_number, c.created_at
    into v_status, v_tid, v_number, v_created
  from stock_transfer_creation_claims c
  where c.org_id = p_org and c.instance_id = p_instance and c.idempotency_key = p_key
  for update;

  if v_created > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    -- Live claim → caller must not create.
    return query select false, v_status, v_tid, v_number;
    return;
  end if;

  -- Expired → reclaim it (we hold the row lock, so this is atomic).
  update stock_transfer_creation_claims
    set status = 'pending', cin7_transfer_id = null, transfer_number = null,
        created_at = clock_timestamp(), updated_at = clock_timestamp()
    where org_id = p_org and instance_id = p_instance and idempotency_key = p_key;
  return query select true, 'pending'::text, null::text, null::text;
end;
$$;

revoke all on function stock_transfer_creation_claim(uuid, uuid, text, integer) from public;
revoke all on function stock_transfer_creation_claim(uuid, uuid, text, integer) from anon, authenticated;
