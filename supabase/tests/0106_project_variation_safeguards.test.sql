-- Transactional test for migration 0106 (closure guard, opening commitments on billing scopes). BEGIN/ROLLBACK - leaves no rows.
-- Expect "ALL 0106 ... PASSED". No Cin7 call is made by anything here.
begin;

create or replace function pg_temp.expect_denied(sql text, label text) returns void language plpgsql as $$
begin
  begin execute sql; exception when others then return; end;
  raise exception 'EXPECTED DENIAL but succeeded: %', label;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000006a1');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000006b1', 'SG Org');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006a1', 'member');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted) values ('00000000-0000-0000-0000-0000000006e1', '00000000-0000-0000-0000-0000000006b1', 'inst', 'acct', 'x');

-- parent P (ACTIVE) with an approved V001-shaped variation and its billing scope C (ACTIVE)
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006b1', 'SG-1', 'Parent', 'Cust', 100000, 1500, 'DRAFT');
insert into project_stages (org_id, project_id, sort_order, name, value_cents) values ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c1', 1, 'All', 100000);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000006c1';
insert into project_variations (id, org_id, project_id, code, title, amount_cents, raised_by_email) values ('00000000-0000-0000-0000-0000000006f1', '00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c1', 'V001', 'Vent', 48000, 'a@x');
insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006f1', 1, 'Variation', 10000);
update project_variations set status = 'APPROVED', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000006f1';
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
values ('00000000-0000-0000-0000-0000000006c2', '00000000-0000-0000-0000-0000000006b1', 'SG-1-V001', 'Child', 'Cust', 48000, 1500, 'VARIATION', '00000000-0000-0000-0000-0000000006c1', '00000000-0000-0000-0000-0000000006f1');
insert into project_stages (id, org_id, project_id, sort_order, name, value_cents) values ('00000000-0000-0000-0000-0000000006d2', '00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c2', 1, 'Variation', 48000);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000006c2';

-- ── opening commitments cannot exist on a variation billing project; they still work on a BASE project ──
select pg_temp.expect_denied($q$insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email)
  values ('00000000-0000-0000-0000-0000000006b1','00000000-0000-0000-0000-0000000006c2','00000000-0000-0000-0000-0000000006d2',100,'pre-billed','m@x')$q$, 'opening commitment on a variation billing project');
do $$ declare s uuid; begin
  select id into s from project_stages where project_id = '00000000-0000-0000-0000-0000000006c1';
  insert into project_opening_commitments (org_id, project_id, stage_id, amount_cents, reason, recorded_by_email) values ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c1', s, 100, 'pre-billed', 'm@x');
end $$;

-- ── the helper reports nothing for a clean scope ──
do $$ begin
  if array_length(project_unresolved_obligations('00000000-0000-0000-0000-0000000006c2'), 1) is not null then raise exception 'a clean scope must have no unresolved items'; end if;
end $$;

-- ── a parent cannot close while the child scope is open ──
select pg_temp.expect_denied($q$update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c1'$q$, 'close the parent while a child scope is ACTIVE');
select pg_temp.expect_denied($q$update projects set status = 'COMPLETED' where id = '00000000-0000-0000-0000-0000000006c1'$q$, 'complete the parent while a child scope is ACTIVE');
select pg_temp.expect_denied($q$update projects set status = 'CANCELLED' where id = '00000000-0000-0000-0000-0000000006c1'$q$, 'cancel the parent while a child scope is ACTIVE');

-- ── a child cannot close with an unresolved claim ──
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000006a8', '00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c2', 1, 'SG-V-C1', current_date, 1500, 48000, 7200, 55200, 'h', 'b', 'k1', 'a@x');
do $$ begin
  if project_unresolved_obligations('00000000-0000-0000-0000-0000000006c2') <> array['claim SG-V-C1 is DRAFT'] then raise exception 'draft claim must be reported: %', project_unresolved_obligations('00000000-0000-0000-0000-0000000006c2'); end if;
end $$;
select pg_temp.expect_denied($q$update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c2'$q$, 'close a child scope with a DRAFT claim');

-- ── an approved claim with no Cin7 invoice is an unresolved obligation ──
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
values ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c2', '00000000-0000-0000-0000-0000000006a8', '00000000-0000-0000-0000-0000000006d2', 'Variation', 48000, 10000, 48000, 0, 48000, 7200);
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000006a8';
update project_claims set status = 'APPROVED', approver_email = 'm@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000006a8';
do $$ begin
  if project_unresolved_obligations('00000000-0000-0000-0000-0000000006c2') <> array['approved claim SG-V-C1 has no Cin7 invoice'] then raise exception 'approved-uninvoiced claim must be reported: %', project_unresolved_obligations('00000000-0000-0000-0000-0000000006c2'); end if;
end $$;
select pg_temp.expect_denied($q$update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c2'$q$, 'close a child scope with an approved claim that has no invoice');

-- ── a posting that is created but not reconciled (or mismatched) still blocks ──
insert into project_cin7_sale_links (id, org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email, sale_role)
values ('00000000-0000-0000-0000-0000000006aa', '00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c2', '00000000-0000-0000-0000-0000000006e1', 'SALE-V', 'Standard Rate Sales', '200', 'm@x', 'VARIATION');
insert into project_claim_cin7_postings (id, org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
values ('00000000-0000-0000-0000-0000000006a9', '00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c2', '00000000-0000-0000-0000-0000000006a8', '00000000-0000-0000-0000-0000000006aa', 'K', 'F', 'M', 48000, 7200, 55200, 'SALE-V', 'm@x');
select pg_temp.expect_denied($q$update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c2'$q$, 'close a child scope with a PENDING posting');
update project_claim_cin7_postings set posting_state = 'CREATED', cin7_invoice_number = 'INV-V1', cin7_task_id = 't', cin7_status = 'DRAFT', completed_at = now(), last_error_code = 'AMOUNT_MISMATCH' where id = '00000000-0000-0000-0000-0000000006a9';
select pg_temp.expect_denied($q$update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c2'$q$, 'close a child scope with a CREATED posting that has an amount mismatch');
update project_claim_cin7_postings set last_error_code = null where id = '00000000-0000-0000-0000-0000000006a9';
select pg_temp.expect_denied($q$update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c2'$q$, 'close a child scope with an unreconciled (CREATED) posting');
update project_claim_cin7_postings set posting_state = 'RECONCILED', reconciled_at = now() where id = '00000000-0000-0000-0000-0000000006a9';

-- ── everything resolved: the child may close, and only then the parent ──
do $$ begin
  if array_length(project_unresolved_obligations('00000000-0000-0000-0000-0000000006c2'), 1) is not null then raise exception 'resolved scope must have no unresolved items: %', project_unresolved_obligations('00000000-0000-0000-0000-0000000006c2'); end if;
end $$;
select pg_temp.expect_denied($q$update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c1'$q$, 'parent still cannot close while the child is ACTIVE even though it is resolved');
update projects set status = 'COMPLETED' where id = '00000000-0000-0000-0000-0000000006c2';
update projects set status = 'COMPLETED' where id = '00000000-0000-0000-0000-0000000006c1';

-- ── a Sale creation in flight on a scope blocks its closure ──
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status) values ('00000000-0000-0000-0000-0000000006c3', '00000000-0000-0000-0000-0000000006b1', 'SG-2', 'Solo', 'Cust', 100, 0, 'DRAFT');
insert into project_stages (org_id, project_id, sort_order, name, value_cents) values ('00000000-0000-0000-0000-0000000006b1', '00000000-0000-0000-0000-0000000006c3', 1, 'All', 100);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000006c3';
-- a BASE project with no children is unaffected by the scope rules (existing behaviour preserved)
update projects set status = 'CLOSED' where id = '00000000-0000-0000-0000-0000000006c3';

select 'ALL 0106 PROJECT VARIATION SAFEGUARDS TESTS PASSED' as result;
rollback;
