-- Transactional test for migration 0056's transfer_creation_claim guard.
-- BEGIN/ROLLBACK: safe against any DB with 0056 applied; leaves no rows.
-- Expect it to print "ALL 0056 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000cc', 'Transfer Idempotency Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000dd', '00000000-0000-0000-0000-0000000000cc', 'Test Instance', 'acct', 'enc');

do $$
declare
  org  uuid := '00000000-0000-0000-0000-0000000000cc';
  inst uuid := '00000000-0000-0000-0000-0000000000dd';
  r1 record; r2 record; r3 record;
begin
  select * into r1 from transfer_creation_claim(org, inst, 'key-A', 900);
  if not r1.claimed or r1.existing_status <> 'pending' then
    raise exception 'first claim should be granted+pending, got claimed=% status=%', r1.claimed, r1.existing_status;
  end if;

  select * into r2 from transfer_creation_claim(org, inst, 'key-A', 900);
  if r2.claimed or r2.existing_status <> 'pending' then
    raise exception 'concurrent second claim should be blocked+pending, got claimed=% status=%', r2.claimed, r2.existing_status;
  end if;

  update transfer_creation_claims set status = 'completed', cin7_task_id = 'T-1', transfer_number = 'TR-0001'
    where org_id = org and instance_id = inst and idempotency_key = 'key-A';

  select * into r3 from transfer_creation_claim(org, inst, 'key-A', 900);
  if r3.claimed or r3.existing_status <> 'completed' or r3.cin7_task_id <> 'T-1' or r3.transfer_number <> 'TR-0001' then
    raise exception 'resubmit should return the existing transfer, got claimed=% status=% task=% number=%',
      r3.claimed, r3.existing_status, r3.cin7_task_id, r3.transfer_number;
  end if;

  select * into r1 from transfer_creation_claim(org, inst, 'key-B', 900);
  if not r1.claimed then raise exception 'a different key should get its own claim'; end if;

  select * into r1 from transfer_creation_claim(org, inst, 'key-A', 0);
  if not r1.claimed or r1.existing_status <> 'pending' then
    raise exception 'expired claim should be reclaimable, got claimed=% status=%', r1.claimed, r1.existing_status;
  end if;
end $$;

do $$ begin raise notice 'ALL 0056 TRANSFER-IDEMPOTENCY ASSERTIONS PASSED'; end $$;

rollback;
