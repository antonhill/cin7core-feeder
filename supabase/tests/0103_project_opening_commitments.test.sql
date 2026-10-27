-- Transactional test for migration 0103 (project opening commitments). BEGIN/ROLLBACK — leaves no rows.
-- Covers: table/FKs, RLS (member read / cross-org denial / no member writes), amount constraint, one row per project+stage,
-- cannot exceed the stage value, FROZEN once any claim exists, and that claim approval counts the opening commitment.
-- Expect it to print "ALL 0103 ... PASSED".
begin;

grant select, insert, update, delete on project_opening_commitments to authenticated, anon;

create or replace function pg_temp.act_as(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
end $$;
create or replace function pg_temp.reset_role() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); end $$;
create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000003a1'), ('00000000-0000-0000-0000-0000000003a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000003b1', 'OC Org A'), ('00000000-0000-0000-0000-0000000003b2', 'OC Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003a1', 'member'),
  ('00000000-0000-0000-0000-0000000003b2', '00000000-0000-0000-0000-0000000003a2', 'member');

insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000003c1', '00000000-0000-0000-0000-0000000003b1', 'P-1', 'Golden', 'Cust', 100000000, 1500, 'DRAFT'),
       ('00000000-0000-0000-0000-0000000003c2', '00000000-0000-0000-0000-0000000003b2', 'P-1', 'Other', 'Cust', 100, 0, 'DRAFT');
insert into project_stages (id, org_id, project_id, sort_order, name, value_cents) values
  ('00000000-0000-0000-0000-0000000003d1', '00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003c1', 1, 'Deposit', 100000000),
  ('00000000-0000-0000-0000-0000000003d2', '00000000-0000-0000-0000-0000000003b2', '00000000-0000-0000-0000-0000000003c2', 1, 'Deposit', 100);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000003c1';

-- constraints
select pg_temp.expect_denied($q$insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('00000000-0000-0000-0000-0000000003b1','00000000-0000-0000-0000-0000000003c1','00000000-0000-0000-0000-0000000003d1',-1,'r','m@x')$q$, 'negative amount');
select pg_temp.expect_denied($q$insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('00000000-0000-0000-0000-0000000003b1','00000000-0000-0000-0000-0000000003c1','00000000-0000-0000-0000-0000000003d1',1,'  ','m@x')$q$, 'blank reason');
select pg_temp.expect_denied($q$insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('00000000-0000-0000-0000-0000000003b1','00000000-0000-0000-0000-0000000003c1','00000000-0000-0000-0000-0000000003d1',100000001,'r','m@x')$q$, 'above the stage value');
select pg_temp.expect_denied($q$insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('00000000-0000-0000-0000-0000000003b2','00000000-0000-0000-0000-0000000003c1','00000000-0000-0000-0000-0000000003d1',1,'r','m@x')$q$, 'composite FK: wrong org for the project');
insert into project_opening_commitments (id, org_id, project_id, stage_id, amount_cents, reason, recorded_by_email)
values ('00000000-0000-0000-0000-0000000003e1', '00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003c1', '00000000-0000-0000-0000-0000000003d1', 40000000, 'POC opening', 'm@x');
select pg_temp.expect_denied($q$insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('00000000-0000-0000-0000-0000000003b1','00000000-0000-0000-0000-0000000003c1','00000000-0000-0000-0000-0000000003d1',1,'r','m@x')$q$, 'second row for the same project+stage');
update project_opening_commitments set amount_cents = 50000000 where id = '00000000-0000-0000-0000-0000000003e1'; -- editable while no claim exists

-- claim approval counts the opening commitment (previously_committed must equal opening 50,000,000)
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000003f1', '00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003c1', 1, 'C-1', current_date, 1500, 10000000, 1500000, 11500000, 'h', 'b', 'k1', 'a@x');
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
values ('00000000-0000-0000-0000-0000000003b1', '00000000-0000-0000-0000-0000000003c1', '00000000-0000-0000-0000-0000000003f1', '00000000-0000-0000-0000-0000000003d1', 'Deposit', 100000000, 6000, 60000000, 50000000, 10000000, 1500000);
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000003f1';
update project_claims set status = 'APPROVED', approver_email = 'm@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000003f1';

-- FROZEN once a claim exists
select pg_temp.expect_denied($q$update project_opening_commitments set amount_cents = 1 where id = '00000000-0000-0000-0000-0000000003e1'$q$, 'edit after a claim exists');
select pg_temp.expect_denied($q$delete from project_opening_commitments where id = '00000000-0000-0000-0000-0000000003e1'$q$, 'delete after a claim exists');

-- RLS
select pg_temp.act_as('00000000-0000-0000-0000-0000000003a1');
do $$ begin if (select count(*) from project_opening_commitments) <> 1 then raise exception 'member A should see its row'; end if; end $$;
select pg_temp.expect_denied($q$update project_opening_commitments set amount_cents = 2$q$, 'member update');
select pg_temp.expect_denied($q$insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('00000000-0000-0000-0000-0000000003b1','00000000-0000-0000-0000-0000000003c1','00000000-0000-0000-0000-0000000003d1',1,'r','m@x')$q$, 'member insert');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000003a2');
do $$ begin if (select count(*) from project_opening_commitments) <> 0 then raise exception 'org B must not see org A rows'; end if; end $$;
select pg_temp.reset_role();

select 'ALL 0103 PROJECT OPENING COMMITMENTS TESTS PASSED' as result;
rollback;
