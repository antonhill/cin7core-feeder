-- Transactional test for migration 0108 (direct non-stock project cost ledger). BEGIN/ROLLBACK - leaves no rows.
-- Covers: constraints, project/org isolation, state machine (COMMITTED -> INCURRED only), immutability, single void, no delete, cascade,
-- RLS (org ADMIN read only: a plain member sees nothing, cross-org denied, no client writes). No Cin7 call is made by anything here.
begin;

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
  if n <> 0 then raise exception 'EXPECTED 0 rows changed but % changed: %', n, label; end if;
end $$;

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000008a1'), ('00000000-0000-0000-0000-0000000008a2'), ('00000000-0000-0000-0000-0000000008a3');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000008b1', 'PC Org A'), ('00000000-0000-0000-0000-0000000008b2', 'PC Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008a1', 'admin'),
  ('00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008a3', 'member'),
  ('00000000-0000-0000-0000-0000000008b2', '00000000-0000-0000-0000-0000000008a2', 'admin');
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status) values
  ('00000000-0000-0000-0000-0000000008c1', '00000000-0000-0000-0000-0000000008b1', 'PC-1', 'P1', 'Cust', 100000, 1500, 'DRAFT'),
  ('00000000-0000-0000-0000-0000000008c3', '00000000-0000-0000-0000-0000000008b2', 'PC-3', 'P3', 'Cust', 100000, 1500, 'DRAFT');

insert into project_cost_entries (id, org_id, project_id, category, description, supplier, amount_cents, state, recorded_by_email) values
  ('00000000-0000-0000-0000-0000000008e1', '00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008c1', 'SUBCONTRACTOR', 'Erectors', 'Acme', 5000000, 'COMMITTED', 'm@x');
insert into project_cost_entries (id, org_id, project_id, category, description, amount_cents, state, incurred_on, recorded_by_email, in_cin7_valuation) values
  ('00000000-0000-0000-0000-0000000008e2', '00000000-0000-0000-0000-0000000008b1', '00000000-0000-0000-0000-0000000008c1', 'TRANSPORT_DELIVERY', 'Truck 1', 1200000, 'INCURRED', current_date, 'm@x', true);

-- constraints
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR','x',0,'m@x')$q$, 'zero amount');
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR','x',-5,'m@x')$q$, 'negative amount');
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','LUNCH','x',5,'m@x')$q$, 'unknown category');
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR',' ',5,'m@x')$q$, 'blank description');
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, state, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR','x',5,'INCURRED','m@x')$q$, 'incurred without an incurred date');
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, state, incurred_on, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR','x',5,'COMMITTED',current_date,'m@x')$q$, 'committed with an incurred date');
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b2','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR','x',5,'m@x')$q$, 'entry whose org does not own the project');
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, recorded_by_email, voided_at, voided_by_email, void_reason) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR','x',5,'m@x',now(),'m@x','born void')$q$, 'created void');

-- immutability and state machine
select pg_temp.expect_denied($q$update project_cost_entries set amount_cents = 1 where id = '00000000-0000-0000-0000-0000000008e1'$q$, 'change an amount');
select pg_temp.expect_denied($q$update project_cost_entries set description = 'x' where id = '00000000-0000-0000-0000-0000000008e1'$q$, 'change a description');
select pg_temp.expect_denied($q$update project_cost_entries set in_cin7_valuation = true where id = '00000000-0000-0000-0000-0000000008e1'$q$, 'flip the double-count flag');
select pg_temp.expect_denied($q$update project_cost_entries set state = 'COMMITTED', incurred_on = null where id = '00000000-0000-0000-0000-0000000008e2'$q$, 'INCURRED back to COMMITTED');
update project_cost_entries set state = 'INCURRED', incurred_on = current_date where id = '00000000-0000-0000-0000-0000000008e1';
select pg_temp.expect_denied($q$update project_cost_entries set incurred_on = current_date - 5 where id = '00000000-0000-0000-0000-0000000008e1'$q$, 'change a fixed incurred date');

-- void once, with a reason; a voided entry is final; nothing is deleted
select pg_temp.expect_denied($q$update project_cost_entries set voided_at = now() where id = '00000000-0000-0000-0000-0000000008e2'$q$, 'void without who/why');
update project_cost_entries set voided_at = now(), voided_by_email = 'm@x', void_reason = 'duplicate invoice' where id = '00000000-0000-0000-0000-0000000008e2';
select pg_temp.expect_denied($q$update project_cost_entries set void_reason = 'again' where id = '00000000-0000-0000-0000-0000000008e2'$q$, 'edit a voided entry');
select pg_temp.expect_denied($q$delete from project_cost_entries where id = '00000000-0000-0000-0000-0000000008e1'$q$, 'delete an entry');

-- RLS: org ADMIN reads; a plain member and another org's admin see nothing; nobody writes through the client
select pg_temp.act_as('00000000-0000-0000-0000-0000000008a1');
do $$ begin if (select count(*) from project_cost_entries) <> 2 then raise exception 'org admin should see both entries'; end if; end $$;
select pg_temp.expect_denied($q$insert into project_cost_entries (org_id, project_id, category, description, amount_cents, recorded_by_email) values ('00000000-0000-0000-0000-0000000008b1','00000000-0000-0000-0000-0000000008c1','SUBCONTRACTOR','admin made',5,'m@x')$q$, 'admin insert through the client');
select pg_temp.expect_no_rows_changed($q$update project_cost_entries set void_reason = 'x'$q$, 'admin update through the client');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000008a3');
do $$ begin if (select count(*) from project_cost_entries) <> 0 then raise exception 'a plain member must not read internal costs'; end if; end $$;
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000008a2');
do $$ begin if (select count(*) from project_cost_entries) <> 0 then raise exception 'org B must not see org A costs'; end if; end $$;
select pg_temp.reset_role();

-- cascade
delete from projects where id = '00000000-0000-0000-0000-0000000008c1';
do $$ begin if (select count(*) from project_cost_entries where project_id = '00000000-0000-0000-0000-0000000008c1') <> 0 then raise exception 'project delete must cascade to cost entries'; end if; end $$;

select 'ALL 0108 PROJECT COST ENTRIES TESTS PASSED' as result;
rollback;
