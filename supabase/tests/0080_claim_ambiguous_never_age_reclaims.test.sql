-- Regression test for migration 0080_claim_ambiguous_never_age_reclaims.sql.
--
-- Security re-audit final closure, Blocker 5 (Anton-approved D5): proves an
-- 'ambiguous' PO/Stock Transfer creation claim is NEVER reclaimed by age
-- alone, no matter how far past its TTL — the caller must keep seeing
-- existing_status='ambiguous' so its own reconciliation path (already
-- correct, see src/app/supplier-planner/actions.ts /
-- src/app/replenish/actions.ts) actually runs before any retry. Also proves
-- the pre-existing, INTENTIONAL behavior for 'pending' and 'completed'
-- claims is unchanged — this migration narrows exactly one case.
--
-- Self-contained and NON-DESTRUCTIVE: everything runs inside one transaction
-- that ROLLS BACK, so it can be run safely against any database (including
-- production) AFTER 0080 is applied.
--
-- Run:  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/0080_claim_ambiguous_never_age_reclaims.test.sql
-- Expect: "ALL 0080 CLAIM RECLAIM ASSERTIONS PASSED" and a ROLLBACK.

begin;

do $$
declare
  org_x uuid := gen_random_uuid();
  inst_x uuid;
  r record;
begin
  insert into organizations (id, name) values (org_x, 'Claim Reclaim Test Org');
  insert into cin7_instances (org_id, name, account_id, application_key_encrypted, base_url, active)
    values (org_x, 'seed', 'acct', 'ciphertext', 'https://inventory.dearsystems.com/ExternalApi/v2', true)
    returning id into inst_x;

  ---------------------------------------------------- PO claims
  -- Scenario A/B/C: an expired ambiguous claim must NOT be reclaimed.
  insert into po_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (org_x, inst_x, 'po-key-ambiguous', 'ambiguous', now() - interval '1 hour', now() - interval '1 hour');
  select * into r from po_creation_claim(org_x, inst_x, 'po-key-ambiguous', 900);
  if r.claimed then
    raise exception 'FAIL: an expired AMBIGUOUS PO claim was reclaimed (claimed=true)';
  end if;
  if r.existing_status <> 'ambiguous' then
    raise exception 'FAIL: expired ambiguous PO claim returned existing_status=% (expected ambiguous)', r.existing_status;
  end if;

  -- Unchanged: a still-live (unexpired) ambiguous claim must also block.
  insert into po_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (org_x, inst_x, 'po-key-ambiguous-live', 'ambiguous', now(), now());
  select * into r from po_creation_claim(org_x, inst_x, 'po-key-ambiguous-live', 900);
  if r.claimed or r.existing_status <> 'ambiguous' then
    raise exception 'FAIL: still-live ambiguous PO claim behaved incorrectly: claimed=%, existing_status=%', r.claimed, r.existing_status;
  end if;

  -- Unchanged: an expired PENDING claim (never attempted) still reclaims.
  insert into po_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (org_x, inst_x, 'po-key-pending', 'pending', now() - interval '1 hour', now() - interval '1 hour');
  select * into r from po_creation_claim(org_x, inst_x, 'po-key-pending', 900);
  if not r.claimed then
    raise exception 'FAIL: an expired PENDING PO claim was NOT reclaimed — regression vs pre-existing behavior';
  end if;

  -- Unchanged: an expired COMPLETED claim still reclaims ("allow a later reorder").
  insert into po_creation_claims (org_id, instance_id, idempotency_key, status, cin7_purchase_id, order_number, created_at, updated_at)
  values (org_x, inst_x, 'po-key-completed', 'completed', 'po-123', 'PO-123', now() - interval '1 hour', now() - interval '1 hour');
  select * into r from po_creation_claim(org_x, inst_x, 'po-key-completed', 900);
  if not r.claimed then
    raise exception 'FAIL: an expired COMPLETED PO claim was NOT reclaimed — regression vs the intentional "allow a later reorder" behavior';
  end if;

  ---------------------------------------------------- Stock Transfer claims (identical shape)
  insert into stock_transfer_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (org_x, inst_x, 'st-key-ambiguous', 'ambiguous', now() - interval '1 hour', now() - interval '1 hour');
  select * into r from stock_transfer_creation_claim(org_x, inst_x, 'st-key-ambiguous', 900);
  if r.claimed then
    raise exception 'FAIL: an expired AMBIGUOUS transfer claim was reclaimed';
  end if;
  if r.existing_status <> 'ambiguous' then
    raise exception 'FAIL: expired ambiguous transfer claim returned existing_status=%', r.existing_status;
  end if;

  insert into stock_transfer_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (org_x, inst_x, 'st-key-ambiguous-live', 'ambiguous', now(), now());
  select * into r from stock_transfer_creation_claim(org_x, inst_x, 'st-key-ambiguous-live', 900);
  if r.claimed or r.existing_status <> 'ambiguous' then
    raise exception 'FAIL: still-live ambiguous transfer claim behaved incorrectly: claimed=%, existing_status=%', r.claimed, r.existing_status;
  end if;

  insert into stock_transfer_creation_claims (org_id, instance_id, idempotency_key, status, created_at, updated_at)
  values (org_x, inst_x, 'st-key-pending', 'pending', now() - interval '1 hour', now() - interval '1 hour');
  select * into r from stock_transfer_creation_claim(org_x, inst_x, 'st-key-pending', 900);
  if not r.claimed then
    raise exception 'FAIL: an expired PENDING transfer claim was NOT reclaimed';
  end if;

  insert into stock_transfer_creation_claims (org_id, instance_id, idempotency_key, status, cin7_transfer_id, transfer_number, created_at, updated_at)
  values (org_x, inst_x, 'st-key-completed', 'completed', 'st-123', 'ST-123', now() - interval '1 hour', now() - interval '1 hour');
  select * into r from stock_transfer_creation_claim(org_x, inst_x, 'st-key-completed', 900);
  if not r.claimed then
    raise exception 'FAIL: an expired COMPLETED transfer claim was NOT reclaimed';
  end if;

  raise notice 'ALL 0080 CLAIM RECLAIM ASSERTIONS PASSED';
end $$;

rollback;
