-- Transactional test for migration 0105 (BASE/VARIATION billing scopes, variation schedules, amendments, Sale roles, posting lines).
-- BEGIN/ROLLBACK - leaves no rows. Covers: existing-project defaults (BASE), scope shape, variation billing-project rules (APPROVED only,
-- amount, customer/tax, BASE parent, one per variation), immutable scope, schedule validation/freeze, deterministic cents split,
-- controlled amendment (audit, rebalance, refused after claims, service-role only), Sale role guard, immutable posting lines, RLS.
-- Expect it to print "ALL 0105 ... PASSED". No Cin7 call is made by anything here.
begin;

grant select, insert, update, delete on project_cin7_sale_creations, project_variation_stages, project_variation_schedule_amendments, projects, project_cin7_sale_links, project_claim_cin7_postings to authenticated, anon;

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
create or replace function pg_temp.expect_no_rows_changed(sql text, label text) returns void language plpgsql as $$
declare n bigint;
begin
  begin execute sql; get diagnostics n = row_count; exception when others then return; end;
  if n > 0 then raise exception 'EXPECTED NO ROWS CHANGED but % row(s) changed: %', n, label; end if;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000005a1'), ('00000000-0000-0000-0000-0000000005a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000005b1', 'MV Org A'), ('00000000-0000-0000-0000-0000000005b2', 'MV Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005a1', 'member'),
  ('00000000-0000-0000-0000-0000000005b2', '00000000-0000-0000-0000-0000000005a2', 'member');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted) values
  ('00000000-0000-0000-0000-0000000005e1', '00000000-0000-0000-0000-0000000005b1', 'inst', 'acct', 'x');

-- Parent (BASE) ACTIVE project and a DRAFT second project. Neither names a scope: existing-row behaviour must default to BASE.
insert into projects (id, org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005b1', 'P-1', 'Base', 'Cust', 'CUST-1', 100000000, 1500, 'DRAFT'),
       ('00000000-0000-0000-0000-0000000005c2', '00000000-0000-0000-0000-0000000005b1', 'P-2', 'Draft', 'Cust', 'CUST-1', 100, 1500, 'DRAFT');
insert into project_stages (id, org_id, project_id, sort_order, name, value_cents)
values ('00000000-0000-0000-0000-0000000005d1', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', 1, 'Deposit', 100000000);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000005c1';

do $$ begin
  if (select count(*) from projects where billing_scope = 'BASE' and parent_project_id is null and variation_id is null) <> 2 then
    raise exception 'existing projects must default to BASE with no parent/variation';
  end if;
end $$;

-- ── scope shape ──────────────────────────────────────────────────────────────
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, original_contract_cents, billing_scope) values ('00000000-0000-0000-0000-0000000005b1','X-1','n','Cust',1,'VARIATION')$q$, 'VARIATION scope without parent/variation');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, original_contract_cents, parent_project_id) values ('00000000-0000-0000-0000-0000000005b1','X-2','n','Cust',1,'00000000-0000-0000-0000-0000000005c1')$q$, 'BASE scope with a parent');
select pg_temp.expect_denied($q$update projects set billing_scope = 'VARIATION' where id = '00000000-0000-0000-0000-0000000005c1'$q$, 'change scope of an existing project');

-- ── variations and their schedules ───────────────────────────────────────────
insert into project_variations (id, org_id, project_id, code, title, amount_cents, raised_by_email)
values ('00000000-0000-0000-0000-0000000005f1', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', 'V001', 'Ventilation', 1000001, 'a@x'),
       ('00000000-0000-0000-0000-0000000005f2', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', 'V002', 'Other', 500000, 'a@x');

select pg_temp.expect_denied($q$insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1',1,'Zero',0)$q$, '0 bps stage');
select pg_temp.expect_denied($q$insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1',1,'  ',100)$q$, 'blank stage name');
insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values
  ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1',1,'Order',3333),
  ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1',2,'Delivery',3333),
  ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1',3,'Commissioning',3333);
select pg_temp.expect_denied($q$insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1',3,'Dup order',1)$q$, 'duplicate sort order');
select pg_temp.expect_denied($q$update project_variations set status = 'APPROVED', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000005f1'$q$, 'approve a schedule totalling 99.99%');
update project_variation_stages set bps = 3334 where variation_id = '00000000-0000-0000-0000-0000000005f1' and sort_order = 3;
update project_variations set estimated_cost_cents = 700000 where id = '00000000-0000-0000-0000-0000000005f1';
select pg_temp.expect_denied($q$update project_variations set estimated_cost_cents = -1 where id = '00000000-0000-0000-0000-0000000005f2'$q$, 'negative estimated cost');
update project_variations set status = 'APPROVED', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000005f1';
select pg_temp.expect_denied($q$update project_variations set estimated_cost_cents = 1 where id = '00000000-0000-0000-0000-0000000005f1'$q$, 'change the estimated cost after approval');
select pg_temp.expect_denied($q$insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1',4,'Late',1)$q$, 'add a stage after approval');
select pg_temp.expect_denied($q$update project_variation_stages set bps = 5000 where variation_id = '00000000-0000-0000-0000-0000000005f1' and sort_order = 1$q$, 'edit a frozen stage');
select pg_temp.expect_denied($q$delete from project_variation_stages where variation_id = '00000000-0000-0000-0000-0000000005f1'$q$, 'delete a frozen stage');

-- ── deterministic cents split: largest remainder, always sums to the amount ──
do $$ begin
  if variation_stage_cents(1000001, array[3333, 3333, 3334]) <> array[333300, 333300, 333401]::bigint[] then raise exception 'split 1 wrong: %', variation_stage_cents(1000001, array[3333, 3333, 3334]); end if;
  if variation_stage_cents(100, array[3333, 3333, 3334]) <> array[33, 33, 34]::bigint[] then raise exception 'split 2 wrong'; end if;
  if variation_stage_cents(1, array[5000, 5000]) <> array[1, 0]::bigint[] then raise exception 'tie must go to the earliest stage'; end if;
  if variation_stage_cents(48000000, array[10000]) <> array[48000000]::bigint[] then raise exception 'single 100%% stage wrong'; end if;
  if (select sum(x) from unnest(variation_stage_cents(999999999, array[1, 2, 9997])) x) <> 999999999 then raise exception 'must sum to the amount'; end if;
end $$;

-- ── variation billing project rules ──────────────────────────────────────────
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
  values ('00000000-0000-0000-0000-0000000005b1','P-1-V002','n','Cust','CUST-1',500000,1500,'VARIATION','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005f2')$q$, 'bill a DRAFT variation');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
  values ('00000000-0000-0000-0000-0000000005b1','P-1-V001','n','Cust','CUST-1',1000000,1500,'VARIATION','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005f1')$q$, 'contract differs from the approved amount');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
  values ('00000000-0000-0000-0000-0000000005b1','P-1-V001','n','Other customer','CUST-2',1000001,1500,'VARIATION','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005f1')$q$, 'different customer');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
  values ('00000000-0000-0000-0000-0000000005b1','P-1-V001','n','Cust','CUST-1',1000001,0,'VARIATION','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005f1')$q$, 'different tax rate');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
  values ('00000000-0000-0000-0000-0000000005b1','P-1-V001','n','Cust','CUST-1',1000001,1500,'VARIATION','00000000-0000-0000-0000-0000000005c2','00000000-0000-0000-0000-0000000005f1')$q$, 'variation of a different (non-owning, non-ACTIVE) parent');
insert into projects (id, org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
values ('00000000-0000-0000-0000-0000000005c3', '00000000-0000-0000-0000-0000000005b1', 'P-1-V001', 'V001 billing', 'Cust', 'CUST-1', 1000001, 1500, 'VARIATION', '00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005f1');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
  values ('00000000-0000-0000-0000-0000000005b1','P-1-V001-again','n','Cust','CUST-1',1000001,1500,'VARIATION','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005f1')$q$, 'a second billing project for the same variation');
select pg_temp.expect_denied($q$insert into projects (org_id, project_reference, name, customer_name, cin7_customer_id, original_contract_cents, tax_rate_bps, billing_scope, parent_project_id, variation_id)
  values ('00000000-0000-0000-0000-0000000005b1','P-nested','n','Cust','CUST-1',1000001,1500,'VARIATION','00000000-0000-0000-0000-0000000005c3','00000000-0000-0000-0000-0000000005f1')$q$, 'a variation of a variation billing project');
select pg_temp.expect_denied($q$update projects set parent_project_id = '00000000-0000-0000-0000-0000000005c2' where id = '00000000-0000-0000-0000-0000000005c3'$q$, 'reparent a billing project');

insert into project_stages (org_id, project_id, sort_order, name, value_cents) values
  ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c3',1,'Order',333300),
  ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c3',2,'Delivery',333300),
  ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c3',3,'Commissioning',333401);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000005c3';

-- ── Sale links: role must match the billing project's scope ──────────────────
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email, sale_role)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c3','00000000-0000-0000-0000-0000000005e1','SALE-X','Standard Rate Sales','200','m@x','BASE')$q$, 'BASE Sale on a variation billing project');
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email, sale_role)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005e1','SALE-Y','Standard Rate Sales','200','m@x','VARIATION')$q$, 'VARIATION Sale on the BASE project');
insert into project_cin7_sale_links (id, org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email) -- sale_role defaults to BASE: backward compatible with 0104 inserts
values ('00000000-0000-0000-0000-0000000005aa', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005e1', 'SALE-BASE', 'Standard Rate Sales', '200', 'm@x');
insert into project_cin7_sale_links (id, org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email, sale_role)
values ('00000000-0000-0000-0000-0000000005ab', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c3', '00000000-0000-0000-0000-0000000005e1', 'SALE-VAR', 'Standard Rate Sales', '200', 'm@x', 'VARIATION');
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email, sale_role)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c3','00000000-0000-0000-0000-0000000005e1','SALE-VAR2','Standard Rate Sales','200','m@x','VARIATION')$q$, 'a second Sale for one billing project');
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c2','00000000-0000-0000-0000-0000000005e1','SALE-BASE','Standard Rate Sales','200','m@x')$q$, 'the same Cin7 Sale on two projects');

-- ── controlled amendment ─────────────────────────────────────────────────────
select pg_temp.expect_denied($q$select amend_variation_schedule('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1','[{"name":"A","bps":5000}]'::jsonb,'why','m@x')$q$, 'amend to a schedule not totalling 100%');
select pg_temp.expect_denied($q$select amend_variation_schedule('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1','[{"name":"A","bps":10000}]'::jsonb,'  ','m@x')$q$, 'amend without a reason');
select pg_temp.expect_denied($q$select amend_variation_schedule('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f2','[{"name":"A","bps":10000}]'::jsonb,'why','m@x')$q$, 'amend a DRAFT variation');
select pg_temp.expect_denied($q$select amend_variation_schedule('00000000-0000-0000-0000-0000000005b2','00000000-0000-0000-0000-0000000005f1','[{"name":"A","bps":10000}]'::jsonb,'why','m@x')$q$, 'amend through another organization');
select pg_temp.act_as('00000000-0000-0000-0000-0000000005a1');
select pg_temp.expect_denied($q$select amend_variation_schedule('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1','[{"name":"A","bps":10000}]'::jsonb,'why','m@x')$q$, 'a signed-in member calling the amendment function');
select pg_temp.reset_role();

select amend_variation_schedule('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1','[{"name":"Whole variation","bps":10000}]'::jsonb,'Customer asked for one invoice','m@x');
do $$ begin
  if (select count(*) from project_variation_stages where variation_id = '00000000-0000-0000-0000-0000000005f1') <> 1 then raise exception 'schedule not replaced'; end if;
  if (select count(*) from project_stages where project_id = '00000000-0000-0000-0000-0000000005c3') <> 1 then raise exception 'billing stages not replaced'; end if;
  if (select value_cents from project_stages where project_id = '00000000-0000-0000-0000-0000000005c3') <> 1000001 then raise exception 'billing stage must carry the whole variation'; end if;
  if (select count(*) from project_variation_schedule_amendments) <> 1 then raise exception 'amendment must be audited'; end if;
  if (select jsonb_array_length(before_stages) from project_variation_schedule_amendments) <> 3 then raise exception 'audit must keep the before-schedule'; end if;
end $$;
select pg_temp.expect_denied($q$update project_variation_schedule_amendments set reason = 'edited'$q$, 'edit the amendment audit');
select pg_temp.expect_denied($q$delete from project_variation_schedule_amendments$q$, 'delete the amendment audit');
select pg_temp.expect_denied($q$update project_variation_stages set bps = 1 where variation_id = '00000000-0000-0000-0000-0000000005f1'$q$, 'the amend flag must not leak past the function');

-- once a claim exists on the billing project, the schedule can no longer be amended
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000005a7', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c3', 1, 'V-C-1', current_date, 1500, 1000001, 150000, 1150001, 'h', 'b', 'kv1', 'a@x');
select pg_temp.expect_denied($q$select amend_variation_schedule('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1','[{"name":"A","bps":5000},{"name":"B","bps":5000}]'::jsonb,'late','m@x')$q$, 'amend after a claim exists');


-- ── a legacy variation (approved with NO schedule, the V001 shape) is allowed, stays unbillable until a manager amends it, and the amendment is audited ──
insert into project_variations (id, org_id, project_id, code, title, amount_cents, raised_by_email)
values ('00000000-0000-0000-0000-0000000005f3', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', 'V003', 'Legacy', 48000000, 'a@x');
update project_variations set status = 'APPROVED', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000005f3';
do $$ begin
  if (select count(*) from project_variation_stages where variation_id = '00000000-0000-0000-0000-0000000005f3') <> 0 then raise exception 'a legacy variation must have no schedule until a manager sets one'; end if;
end $$;
select pg_temp.expect_denied($q$insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f3',1,'Direct',10000)$q$, 'a direct schedule insert on an approved variation');
select amend_variation_schedule('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f3','[{"name":"Variation","bps":10000}]'::jsonb,'First schedule for a variation approved before schedules existed','m@x');
do $$ begin
  if (select count(*) from project_variation_stages where variation_id = '00000000-0000-0000-0000-0000000005f3') <> 1 then raise exception 'legacy schedule not set'; end if;
  if (select jsonb_array_length(before_stages) from project_variation_schedule_amendments where variation_id = '00000000-0000-0000-0000-0000000005f3') <> 0 then raise exception 'audit must show the empty before-schedule'; end if;
end $$;
-- a partial schedule can still not be approved
insert into project_variations (id, org_id, project_id, code, title, amount_cents, raised_by_email)
values ('00000000-0000-0000-0000-0000000005f4', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', 'V004', 'Partial', 100, 'a@x');
insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f4',1,'Half',5000);
select pg_temp.expect_denied($q$update project_variations set status = 'APPROVED', decided_by_email = 'm@x', decided_at = now() where id = '00000000-0000-0000-0000-0000000005f4'$q$, 'approve a schedule totalling 50%');

-- ── postings: invoiced product lines are valid and immutable ─────────────────
insert into project_claims (id, org_id, project_id, claim_seq, claim_number, claim_date, tax_rate_bps, subtotal_cents, tax_cents, total_cents, snapshot_hash, baseline_hash, idempotency_key, author_email)
values ('00000000-0000-0000-0000-0000000005a8', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', 1, 'C-1', current_date, 1500, 10000000, 1500000, 11500000, 'h', 'b', 'k1', 'a@x');
insert into project_claim_lines (org_id, project_id, claim_id, stage_id, stage_name, stage_value_cents, approved_bps, earned_to_date_cents, previously_committed_cents, current_claim_cents, tax_cents)
values ('00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005a8', '00000000-0000-0000-0000-0000000005d1', 'Deposit', 100000000, 1000, 10000000, 0, 10000000, 1500000);
update project_claims set status = 'READY_FOR_APPROVAL' where id = '00000000-0000-0000-0000-0000000005a8';
update project_claims set status = 'APPROVED', approver_email = 'm@x', approved_at = now() where id = '00000000-0000-0000-0000-0000000005a8';
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email, physical_lines)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005a8','00000000-0000-0000-0000-0000000005aa','K','F','M',10000000,1500000,11500000,'SALE-BASE','m@x','[]'::jsonb)$q$, 'an empty physical_lines array');
select pg_temp.expect_denied($q$insert into project_claim_cin7_postings (org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email, physical_lines)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005a8','00000000-0000-0000-0000-0000000005ab','K','F','M',10000000,1500000,11500000,'SALE-VAR','m@x',null)$q$, 'a BASE claim posted to the variation Sale');
insert into project_claim_cin7_postings (id, org_id, project_id, claim_id, sale_link_id, idempotency_key, request_fingerprint, memo, amount_ex_vat_cents, tax_cents, total_cents, cin7_sale_id, requested_by_email, physical_lines)
values ('00000000-0000-0000-0000-0000000005a9', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c1', '00000000-0000-0000-0000-0000000005a8', '00000000-0000-0000-0000-0000000005aa', 'NEWQUIP:P-1:C-1:x', 'fp', 'NEWQUIP-PROJECTS:P-1:C-1', 10000000, 1500000, 11500000, 'SALE-BASE', 'm@x', '[{"sku":"A","quantity":2}]'::jsonb);
select pg_temp.expect_denied($q$update project_claim_cin7_postings set physical_lines = '[{"sku":"A","quantity":3}]'::jsonb where id = '00000000-0000-0000-0000-0000000005a9'$q$, 'change the invoiced product lines');
select pg_temp.expect_denied($q$update project_claim_cin7_postings set physical_lines = null where id = '00000000-0000-0000-0000-0000000005a9'$q$, 'remove the invoiced product lines');


-- ── Sale creation intents ────────────────────────────────────────────────────
-- c2 is DRAFT (not ACTIVE); c1 already has a linked Sale; c3 (variation billing project) is linked too. Use fresh ACTIVE projects.
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status)
values ('00000000-0000-0000-0000-0000000005c4', '00000000-0000-0000-0000-0000000005b1', 'P-4', 'Create me', 'Cust', 100000, 1500, 'DRAFT');
insert into project_stages (org_id, project_id, sort_order, name, value_cents) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c4',1,'All',100000);
update projects set status = 'ACTIVE' where id = '00000000-0000-0000-0000-0000000005c4';

select pg_temp.expect_denied($q$insert into project_cin7_sale_creations (org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c2','00000000-0000-0000-0000-0000000005e1','BASE','X-2','fp','{}',100,'m@x')$q$, 'intent for a project that is not ACTIVE');
select pg_temp.expect_denied($q$insert into project_cin7_sale_creations (org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c1','00000000-0000-0000-0000-0000000005e1','BASE','X-1','fp','{}',100,'m@x')$q$, 'intent for a project that already has a linked Sale');
select pg_temp.expect_denied($q$insert into project_cin7_sale_creations (org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c4','00000000-0000-0000-0000-0000000005e1','VARIATION','X-4','fp','{}',100,'m@x')$q$, 'VARIATION intent on a BASE project');
select pg_temp.expect_denied($q$insert into project_cin7_sale_creations (org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email, creation_state)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c4','00000000-0000-0000-0000-0000000005e1','BASE','X-4','fp','{}',100,'m@x','CREATED')$q$, 'an intent created already CREATED');
insert into project_cin7_sale_creations (id, org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email)
values ('00000000-0000-0000-0000-0000000005b9', '00000000-0000-0000-0000-0000000005b1', '00000000-0000-0000-0000-0000000005c4', '00000000-0000-0000-0000-0000000005e1', 'BASE', 'NEWQUIP-PROJECTS-SALE:P-4', 'fp', '{"customer":"X"}', 100000, 'm@x');
select pg_temp.expect_denied($q$insert into project_cin7_sale_creations (org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c4','00000000-0000-0000-0000-0000000005e1','BASE','X-again','fp','{}',100,'m@x')$q$, 'a second intent for the same project (replay/double click)');
select pg_temp.expect_denied($q$update project_cin7_sale_creations set plan = '{"customer":"Y"}' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'change the plan');
select pg_temp.expect_denied($q$update project_cin7_sale_creations set external_id = 'other' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'change the external id');
select pg_temp.expect_denied($q$update project_cin7_sale_creations set creation_state = 'CREATED' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'CREATED without a Sale id');
select pg_temp.expect_denied($q$delete from project_cin7_sale_creations where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'delete an intent');
-- a Sale link cannot race an in-flight creation
select pg_temp.expect_denied($q$insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email)
  values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c4','00000000-0000-0000-0000-0000000005e1','SALE-RACE','Standard Rate Sales','200','m@x')$q$, 'link while the creation is PENDING');
-- orphan header: the Sale exists, so it can never be a confirmed no-write failure
update project_cin7_sale_creations set creation_state = 'FAILED_UNCERTAIN', progress = 'HEADER', cin7_sale_id = 'SALE-ORPHAN', last_error_code = 'ORPHAN_HEADER' where id = '00000000-0000-0000-0000-0000000005b9';
select pg_temp.expect_denied($q$update project_cin7_sale_creations set creation_state = 'FAILED_CONFIRMED_NO_WRITE' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'no-write failure for a Sale that exists');
select pg_temp.expect_denied($q$update project_cin7_sale_creations set creation_state = 'PENDING', attempt_count = 2 where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'retry straight from FAILED_UNCERTAIN');
select pg_temp.expect_denied($q$update project_cin7_sale_creations set progress = 'NONE' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'progress moving backwards');
select pg_temp.expect_denied($q$update project_cin7_sale_creations set cin7_sale_id = 'ANOTHER' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'change the created Sale reference');
update project_cin7_sale_creations set creation_state = 'CREATED', progress = 'DONE', completed_at = now() where id = '00000000-0000-0000-0000-0000000005b9';
select pg_temp.expect_denied($q$update project_cin7_sale_creations set creation_state = 'RECONCILED' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'RECONCILED without verification time');
update project_cin7_sale_creations set creation_state = 'RECONCILED', verified_at = now() where id = '00000000-0000-0000-0000-0000000005b9';
select pg_temp.expect_denied($q$update project_cin7_sale_creations set creation_state = 'CREATED' where id = '00000000-0000-0000-0000-0000000005b9'$q$, 'leave RECONCILED');
-- once reconciled the Sale can be linked
insert into project_cin7_sale_links (org_id, project_id, instance_id, cin7_sale_id, tax_rule, revenue_account, linked_by_email)
values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c4','00000000-0000-0000-0000-0000000005e1','SALE-ORPHAN','Standard Rate Sales','200','m@x');

-- ── RLS ──────────────────────────────────────────────────────────────────────
select pg_temp.act_as('00000000-0000-0000-0000-0000000005a1');
do $$ begin
  if (select count(*) from project_variation_stages) <> 3 then raise exception 'member A should see its schedules'; end if;
  if (select count(*) from project_variation_schedule_amendments) <> 2 then raise exception 'member A should see its amendment audit'; end if;
  if (select count(*) from project_cin7_sale_creations) <> 1 then raise exception 'member A should see its creation intent'; end if;
end $$;
select pg_temp.expect_no_rows_changed($q$update project_cin7_sale_creations set last_error_message = 'x'$q$, 'member update creation intent');
select pg_temp.expect_denied($q$insert into project_cin7_sale_creations (org_id, project_id, instance_id, sale_role, external_id, request_fingerprint, plan, contract_ex_vat_cents, requested_by_email) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005c3','00000000-0000-0000-0000-0000000005e1','VARIATION','Z','f','{}',1,'m@x')$q$, 'member insert creation intent');
select pg_temp.expect_no_rows_changed($q$update project_variation_stages set name = 'x'$q$, 'member update schedule');
select pg_temp.expect_denied($q$insert into project_variation_stages (org_id, variation_id, sort_order, name, bps) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f2',1,'x',10000)$q$, 'member insert schedule');
select pg_temp.expect_denied($q$insert into project_variation_schedule_amendments (org_id, variation_id, reason, amended_by_email, before_stages, after_stages) values ('00000000-0000-0000-0000-0000000005b1','00000000-0000-0000-0000-0000000005f1','r','m@x','[]','[]')$q$, 'member insert amendment');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000005a2');
do $$ begin
  if (select count(*) from project_variation_stages) <> 0 then raise exception 'org B must not see org A schedules'; end if;
  if (select count(*) from project_variation_schedule_amendments) <> 0 then raise exception 'org B must not see org A amendments'; end if;
  if (select count(*) from projects) <> 0 then raise exception 'org B must not see org A projects'; end if;
  if (select count(*) from project_cin7_sale_creations) <> 0 then raise exception 'org B must not see org A creation intents'; end if;
end $$;
select pg_temp.reset_role();

select 'ALL 0105 PROJECT MULTI-SALE VARIATION BILLING TESTS PASSED' as result;
rollback;
