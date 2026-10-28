-- Transactional test for migration 0104 (Cin7 Sale link + claim postings). BEGIN/ROLLBACK — leaves no rows.
-- Covers: RLS (member read / cross-org denial / no member writes), one Sale link per project, immutable link, one posting per claim,
-- only APPROVED claims, posting state machine (uncertain can never go straight back to PENDING; RECONCILED final), frozen request
-- identity/amounts, no deletes. Expect it to print "ALL 0104 ... PASSED". No Cin7 call is made by anything here.
begin;

grant select, insert, update, delete on project_cin7_sale_links, project_claim_cin7_postings to authenticated, anon;

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
-- RLS with no UPDATE/DELETE policy filters rows out: the statement succeeds but changes ZERO rows (it does not raise).
create or replace function pg_temp.expect_no_rows_changed(sql text, label text) returns void language plpgsql as $$
declare n bigint;
begin
  begin execute sql; get diagnostics n = row_count; exception when others then return; end;
  if n > 0 then raise exception 'EXPECTED NO ROWS CHANGED but % row(s) changed: %', n, label; end if;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000004a1'), ('00000000-0000-0000-0000-0000000004a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000004b1', 'CP Org A'), ('00000000-0000-0000-0000-0000000004b2', 'CP Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004a1', 'member'),
  ('00000000-0000-0000-0000-0000000004b2', '00000000-0000-0000-0000-0000000004a2', 'member');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted) values
  ('00000000-0000-0000-0000-0000000004e1', '00000000-0000-0000-0000-0000000004b1', 'inst', 'acct', 'x');

insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004b1', 'P-1', 'Golden', 'Cust', 100000000, 1500, 'DRAFT'),
       ('00000000-0000-0000-0000-0000000004c2', '00000000-0000-0000-0000-0000000004b1', 'P-2', 'Draft', 'Cust', 100, 0, 'DRAFT');
insert into project_stages (id, org_id, project_id, sort_order, name, value_cents)
values ('00000000-0000-0000-0000-0000000004d1', '00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004c1', 1, 'Deposit', 100000000);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000004c1';

-- ── Sale link ────────────────────────────────────────────────────────────────
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c2','00000000-0000-0000-0000-0000000004e1','S2','Standard Rate Sales','200','m@x')$q$, 'link on a project that is not ACTIVE');
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004e1','S1','','200','m@x')$q$, 'blank tax rule');
insert into project_cin7_sale_links (id, org_id, project_id, instance_id, cin7_sale_id, cin7_sale_number, tax_rule, revenue_account, linked_by_email)
values ('00000000-0000-0000-0000-0000000004f1', '00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004e1', 'SALE-1', 'SO-1', 'Standard Rate Sales', '200', 'm@x');
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004e1','SALE-2','Standard Rate Sales','200','m@x')$q$, 'second Sale for the same project');
select pg_temp.expect_denied($q$update project_cin7_sale_links set cin7_sale_id = 'OTHER' where id = '00000000-0000-0000-0000-0000000004f1'$q$, 'reassign the linked Sale');
select pg_temp.expect_denied($q$update project_cin7_sale_links set revenue_account = '999' where id = '00000000-0000-0000-0000-0000000004f1'$q$, 'change the revenue account');
select pg_temp.expect_denied($q$delete from project_cin7_sale_links where id = '00000000-0000-0000-0000-0000000004f1'$q$, 'unlink');
update project_cin7_sale_links set last_reconciled_at = now() where id = '00000000-0000-0000-0000-0000000004f1';

-- ── claims: one DRAFT, one APPROVED ──────────────────────────────────────────
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000004a8', '00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004c1', 1, 'C-1', current_date, 1500, 10000000, 1500000, 11500000, 'h', 'b', 'k1', 'a@x');
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
values ('00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004a8', '00000000-0000-0000-0000-0000000004d1', 'Deposit', 100000000, 1000, 10000000, 0, 10000000, 1500000);

select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004a8','00000000-0000-0000-0000-0000000004f1','K','F','M',10000000,1500000,11500000,'SALE-1','m@x')$q$, 'post a DRAFT claim');
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000004a8';
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004a8','00000000-0000-0000-0000-0000000004f1','K','F','M',10000000,1500000,11500000,'SALE-1','m@x')$q$, 'post a READY_FOR_APPROVAL claim');
update project_claims set status = 'APPROVED', approver_email = 'm@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000004a8';

-- ── postings ─────────────────────────────────────────────────────────────────
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004a8','00000000-0000-0000-0000-0000000004f1','K','F','M',10000000,1500000,11500001,'SALE-1','m@x')$q$, 'total != ex VAT + VAT');
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004a8','00000000-0000-0000-0000-0000000004f1','K','F','M',10000000,1500000,11500000,'WRONG-SALE','m@x')$q$, 'posting to a Sale that is not the linked one');
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, posting_state, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004a8','00000000-0000-0000-0000-0000000004f1','K','F','M','CREATED',10000000,1500000,11500000,'SALE-1','m@x')$q$, 'create a posting already CREATED');
insert into project_claim_cin7_postings (id, org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
values ('00000000-0000-0000-0000-0000000004a9', '00000000-0000-0000-0000-0000000004b1', '00000000-0000-0000-0000-0000000004c1', '00000000-0000-0000-0000-0000000004a8', '00000000-0000-0000-0000-0000000004f1', 'NEWQUIP:P-1:C-1:x', 'fp', 'NEWQUIP-PROJECTS:P-1:C-1', 10000000, 1500000, 11500000, 'SALE-1', 'm@x');
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004a8','00000000-0000-0000-0000-0000000004f1','K2','F2','M2',10000000,1500000,11500000,'SALE-1','m@x')$q$, 'a SECOND posting for the same claim');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set amount_ex_vat_cents = 1, total_cents = 1501 , tax_cents = 1500 where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'change the posted amount');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set memo = 'other' where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'change the memo');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set idempotency_key = 'other' where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'change the idempotency key');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set posting_state = 'CREATED' where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'CREATED without an invoice reference');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set posting_state = 'RECONCILED', reconciled_at = now() where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'PENDING straight to RECONCILED');

-- uncertain can NEVER go straight back to PENDING
update project_claim_cin7_postings set posting_state = 'FAILED_UNCERTAIN', last_error_code = 'UNCERTAIN' where id = '00000000-0000-0000-0000-0000000004a9';
select pg_temp.expect_denied($q$update project_claim_cin7_postings set posting_state = 'PENDING', attempt_count = 2 where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'retry from FAILED_UNCERTAIN');
-- ...but reconciliation may prove no write; then (and only then) a retry is legal, with attempt_count incremented
update project_claim_cin7_postings set posting_state = 'FAILED_CONFIRMED_NO_WRITE' where id = '00000000-0000-0000-0000-0000000004a9';
select pg_temp.expect_denied($q$update project_claim_cin7_postings set posting_state = 'PENDING' where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'retry without incrementing attempt_count');
update project_claim_cin7_postings set posting_state = 'PENDING', attempt_count = 2 where id = '00000000-0000-0000-0000-0000000004a9';
update project_claim_cin7_postings set posting_state = 'CREATED', cin7_invoice_number = 'INV-1', cin7_task_id = 'T1', cin7_status = 'DRAFT', completed_at = now() where id = '00000000-0000-0000-0000-0000000004a9';
select pg_temp.expect_denied($q$update project_claim_cin7_postings set posting_state = 'PENDING', attempt_count = 3 where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'retry a CREATED posting');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set posting_state = 'FAILED_CONFIRMED_NO_WRITE' where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'release a CREATED posting');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set cin7_invoice_number = 'INV-2' where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'change the created invoice number');
update project_claim_cin7_postings set posting_state = 'RECONCILED', reconciled_at = now() where id = '00000000-0000-0000-0000-0000000004a9';
select pg_temp.expect_denied($q$update project_claim_cin7_postings set posting_state = 'CREATED' where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'leave RECONCILED');
select pg_temp.expect_denied($q$delete from project_claim_cin7_postings where id = '00000000-0000-0000-0000-0000000004a9'$q$, 'delete a posting');

-- ── RLS ──────────────────────────────────────────────────────────────────────
select pg_temp.act_as('00000000-0000-0000-0000-0000000004a1');
do $$ begin
  if (select count(*) from project_cin7_sale_links) <> 1 then raise exception 'member A should see its link'; end if;
  if (select count(*) from project_claim_cin7_postings) <> 1 then raise exception 'member A should see its posting'; end if;
end $$;
select pg_temp.expect_no_rows_changed($q$update project_claim_cin7_postings set last_error_message = 'x'$q$, 'member update posting');
select pg_temp.expect_no_rows_changed($q$update project_cin7_sale_links set last_reconciled_at = now()$q$, 'member update link');
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email)
  values ('00000000-0000-0000-0000-0000000004b1','00000000-0000-0000-0000-0000000004c1','00000000-0000-0000-0000-0000000004a8','00000000-0000-0000-0000-0000000004f1','K3','F3','M3',1,0,1,'SALE-1','m@x')$q$, 'member insert posting');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000004a2');
do $$ begin
  if (select count(*) from project_cin7_sale_links) <> 0 then raise exception 'org B must not see org A links'; end if;
  if (select count(*) from project_claim_cin7_postings) <> 0 then raise exception 'org B must not see org A postings'; end if;
end $$;
select pg_temp.reset_role();

select 'ALL 0104 PROJECT CIN7 CLAIM POSTING TESTS PASSED' as result;
rollback;
