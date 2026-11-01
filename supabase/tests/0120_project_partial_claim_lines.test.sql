-- Transactional test for migration 0120 (partial progress-claim amounts). BEGIN/ROLLBACK - leaves no rows.
-- Covers: the old equality still binds every non-partial line; a partial line must be strictly below the maximum and above zero; no overclaim
-- beyond the stage value; the reservation/staleness check on approval works with partial amounts; the remainder is claimable by a later full
-- claim; approved lines stay frozen. Expect "ALL 0120 ... PASSED".
begin;

create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000120b1', 'PC Org');
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000120c1', '00000000-0000-0000-0000-0000000120b1', 'P-PC', 'Partial', 'Cust', 100000000, 1500, 'DRAFT');
insert into project_stages (id, org_id, project_id, sort_order, name, value_cents)
values ('00000000-0000-0000-0000-0000000120d1', '00000000-0000-0000-0000-0000000120b1', '00000000-0000-0000-0000-0000000120c1', 1, 'Deposit', 100000000);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000120c1';

-- the column exists, defaults to false
do $$ begin
  if not exists (select 1 from information_schema.columns where table_name = 'project_claim_lines' and column_name = 'partial' and column_default = 'false') then
    raise exception 'partial column missing or wrong default';
  end if;
end $$;

-- Claim A (DRAFT): earned R100,000 (10%) of a R1,000,000 stage, nothing committed before.
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000120a1', '00000000-0000-0000-0000-0000000120b1', '00000000-0000-0000-0000-0000000120c1', 1, 'C-1', current_date, 1500, 4000000, 600000, 4600000, 'h1', 'b', 'k1', 'a@x');

-- non-partial line must still satisfy the OLD equality
select pg_temp.expect_denied($q$insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
  values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a1','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,1000,10000000,0,4000000,600000)$q$, 'non-partial line below the maximum');
-- partial line: at the maximum, above it, zero, negative -> all denied
select pg_temp.expect_denied($q$insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents, partial)
  values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a1','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,1000,10000000,0,10000000,1500000,true)$q$, 'partial line equal to the maximum');
select pg_temp.expect_denied($q$insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents, partial)
  values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a1','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,1000,10000000,0,10000001,1500000,true)$q$, 'partial line above the maximum (overclaim)');
select pg_temp.expect_denied($q$insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents, partial)
  values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a1','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,1000,10000000,0,0,0,true)$q$, 'zero partial amount');
select pg_temp.expect_denied($q$insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents, partial)
  values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a1','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,1000,10000000,0,-5,0,true)$q$, 'negative partial amount');

-- a valid partial line: R40,000 of the R100,000 earned
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents, partial)
values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a1','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,1000,10000000,0,4000000,600000,true);

-- approve A: reserves R40,000 only
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000120a1';
update project_claims set status = 'APPROVED', approver_email = 'm@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000120a1';
select pg_temp.expect_denied($q$update project_claim_lines set current_claim_cents = 5000000 where claim_id = '00000000-0000-0000-0000-0000000120a1'$q$, 'edit an approved partial line');
select pg_temp.expect_denied($q$update project_claim_lines set partial = false where claim_id = '00000000-0000-0000-0000-0000000120a1'$q$, 'flip an approved line out of partial');

-- Claim B takes the remainder: previously committed must equal what A reserves (R40,000), and it is a FULL line (6,000,000 = 10,000,000 - 4,000,000)
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000120a2', '00000000-0000-0000-0000-0000000120b1', '00000000-0000-0000-0000-0000000120c1', 2, 'C-2', current_date, 1500, 6000000, 900000, 6900000, 'h2', 'b', 'k2', 'a@x');
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a2','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,1000,10000000,4000000,6000000,900000);
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000120a2';
update project_claims set status = 'APPROVED', approver_email = 'm@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000120a2';

-- Claim C drafted with the WRONG previously-committed (ignoring the reservations) is stale and cannot be approved
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000120a3', '00000000-0000-0000-0000-0000000120b1', '00000000-0000-0000-0000-0000000120c1', 3, 'C-3', current_date, 1500, 1000000, 150000, 1150000, 'h3', 'b', 'k3', 'a@x');
-- earned R200,000 (20%), but R100,000 already reserved by A+B; a draft that forgot them would double-reserve
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents, partial)
values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a3','00000000-0000-0000-0000-0000000120d1','Deposit',100000000,2000,20000000,4000000,1000000,150000,true);
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000120a3';
select pg_temp.expect_denied($q$update project_claims set status = 'APPROVED', approver_email = 'm@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000120a3'$q$, 'approve a partial claim whose previously-committed ignores reservations');

-- cumulative cap: a line can never push committed beyond the stage value
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000120a4', '00000000-0000-0000-0000-0000000120b1', '00000000-0000-0000-0000-0000000120c1', 4, 'C-4', current_date, 1500, 20000000, 3000000, 23000000, 'h4', 'b', 'k4', 'a@x');
select pg_temp.expect_denied($q$insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents, partial)
  values ('00000000-0000-0000-0000-0000000120b1','00000000-0000-0000-0000-0000000120c1','00000000-0000-0000-0000-0000000120a4','00000000-0000-0000-0000-0000000120d1','Deposit2',100000000,10000,100000000,90000000,20000000,3000000,true)$q$, 'committed beyond the stage value');

select 'ALL 0120 PROJECT PARTIAL CLAIM LINE TESTS PASSED' as result;
rollback;
