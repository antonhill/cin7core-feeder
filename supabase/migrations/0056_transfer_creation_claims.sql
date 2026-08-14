-- Phase 4.2: idempotency guard for Stock Transfer creation.
--
-- createReplenishTransfersAction creates a REAL Cin7 Stock Transfer per
-- destination with NO pre-write idempotency and (unlike POs) not even a memory
-- table — a double-click / two tabs / concurrent invocation of the same
-- selection creates duplicate PHYSICAL inventory movements. Same claim pattern
-- as Phase 4.1's po_creation_claims (migration 0055), for transfers.
--
-- Service-role only: RLS on, no policies, EXECUTE revoked from anon/authenticated.

create table if not exists transfer_creation_claims (
  org_id           uuid not null references organizations (id) on delete cascade,
  instance_id      uuid not null references cin7_instances (id) on delete cascade,
  -- Deterministic hash of (from, to, sorted lines+quantities) — see
  -- src/lib/transfer-idempotency.ts.
  idempotency_key  text not null,
  status           text not null default 'pending',   -- 'pending' | 'completed'
  cin7_task_id     text,
  transfer_number  text,
  created_at       timestamptz not null default clock_timestamp(),
  updated_at       timestamptz not null default clock_timestamp(),
  primary key (org_id, instance_id, idempotency_key)
);

alter table transfer_creation_claims enable row level security;
-- No policies: only the service-role client (which bypasses RLS) ever touches this.

comment on table transfer_creation_claims is
  'Phase 4.2 stock-transfer-creation idempotency guard — one short-lived claim per (org,instance,line-set hash). Service-role only.';

/*
 * Atomically try to claim the right to create a stock transfer for
 * (p_org, p_instance, p_key). Semantics identical to po_creation_claim (0055):
 *   claimed=true  → caller owns a fresh claim; create the transfer then settle
 *                   (or delete the claim on failure).
 *   claimed=false → a LIVE claim exists; use existing_status ('completed' →
 *                   return the existing transfer; 'pending' → another request is
 *                   creating it right now). A claim past p_ttl_seconds is
 *                   reclaimable (deliberate later re-transfer allowed).
 */
create or replace function transfer_creation_claim(
  p_org uuid,
  p_instance uuid,
  p_key text,
  p_ttl_seconds integer
) returns table (claimed boolean, existing_status text, cin7_task_id text, transfer_number text)
language plpgsql
as $$
declare
  v_status  text;
  v_task    text;
  v_number  text;
  v_created timestamptz;
begin
  insert into transfer_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (p_org, p_instance, p_key, 'pending', clock_timestamp(), clock_timestamp())
  on conflict (org_id, instance_id, idempotency_key) do nothing;

  if found then
    return query select true, 'pending'::text, null::text, null::text;
    return;
  end if;

  -- Table-qualified: the RETURNS TABLE output params share the names
  -- cin7_task_id / transfer_number, so an unqualified select is ambiguous.
  select c.status, c.cin7_task_id, c.transfer_number, c.created_at
    into v_status, v_task, v_number, v_created
  from transfer_creation_claims c
  where c.org_id = p_org and c.instance_id = p_instance and c.idempotency_key = p_key
  for update;

  if v_created > clock_timestamp() - make_interval(secs => p_ttl_seconds) then
    return query select false, v_status, v_task, v_number;
    return;
  end if;

  update transfer_creation_claims
    set status = 'pending', cin7_task_id = null, transfer_number = null,
        created_at = clock_timestamp(), updated_at = clock_timestamp()
    where org_id = p_org and instance_id = p_instance and idempotency_key = p_key;
  return query select true, 'pending'::text, null::text, null::text;
end;
$$;

revoke all on function transfer_creation_claim(uuid, uuid, text, integer) from public;
revoke all on function transfer_creation_claim(uuid, uuid, text, integer) from anon, authenticated;
