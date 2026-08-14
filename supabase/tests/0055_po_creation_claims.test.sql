-- Transactional test for migration 0055's po_creation_claim idempotency guard.
-- BEGIN/ROLLBACK: safe against any DB with 0055 applied; leaves no rows.
-- Needs a real organizations + cin7_instances row (FKs); creates temp ones and
-- rolls them back. Expect it to print "ALL 0055 ... PASSED".

begin;

-- Minimal FK parents (rolled back).
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000aa', 'PO Idempotency Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000bb', '00000000-0000-0000-0000-0000000000aa', 'Test Instance', 'acct', 'enc');

do $$
declare
  org  uuid := '00000000-0000-0000-0000-0000000000aa';
  inst uuid := '00000000-0000-0000-0000-0000000000bb';
  r1 record; r2 record; r3 record;
begin
  -- First claim for a key → granted (claimed=true, pending).
  select * into r1 from po_creation_claim(org, inst, 'key-A', 900);
  if not r1.claimed or r1.existing_status <> 'pending' then
    raise exception 'first claim should be granted+pending, got claimed=% status=%', r1.claimed, r1.existing_status;
  end if;

  -- Second claim for the SAME key while first is still pending → blocked
  -- (claimed=false, pending) — this is the concurrent double-submit case.
  select * into r2 from po_creation_claim(org, inst, 'key-A', 900);
  if r2.claimed or r2.existing_status <> 'pending' then
    raise exception 'concurrent second claim should be blocked+pending, got claimed=% status=%', r2.claimed, r2.existing_status;
  end if;

  -- Settle the claim (as the app does after creating the PO).
  update po_creation_claims set status = 'completed', cin7_purchase_id = 'PO-1', order_number = 'PO-0001'
    where org_id = org and instance_id = inst and idempotency_key = 'key-A';

  -- Resubmit of the same key while completed+live → blocked, returns the PO.
  select * into r3 from po_creation_claim(org, inst, 'key-A', 900);
  if r3.claimed or r3.existing_status <> 'completed' or r3.cin7_purchase_id <> 'PO-1' or r3.order_number <> 'PO-0001' then
    raise exception 'resubmit should return the existing PO, got claimed=% status=% pid=% order=%',
      r3.claimed, r3.existing_status, r3.cin7_purchase_id, r3.order_number;
  end if;

  -- A DIFFERENT key (different line-set) → its own fresh claim.
  select * into r1 from po_creation_claim(org, inst, 'key-B', 900);
  if not r1.claimed then raise exception 'a different key should get its own claim'; end if;

  -- Expiry: a completed claim past its TTL is reclaimable (deliberate re-order
  -- later). ttl=0 makes the existing 'key-A' claim already expired.
  select * into r1 from po_creation_claim(org, inst, 'key-A', 0);
  if not r1.claimed or r1.existing_status <> 'pending' then
    raise exception 'expired claim should be reclaimable, got claimed=% status=%', r1.claimed, r1.existing_status;
  end if;
end $$;

do $$ begin raise notice 'ALL 0055 PO-IDEMPOTENCY ASSERTIONS PASSED'; end $$;

rollback;
