-- Transactional test for migration 0107 (delivery allocation, allocation audit, milestone confirmations). BEGIN/ROLLBACK - leaves no rows.
-- Covers: table constraints, project/org isolation (composite FKs), BASE vs variation-scope independence, cancelled-delivery guard,
-- append-only audit and confirmation history, RLS (member read / cross-org denial / no member writes), cascade on project delete.
-- Expect "ALL 0107 ... PASSED". No Cin7 call is made by anything here.
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

insert into auth.users (id) values ('00000000-0000-0000-0000-0000000007a1'), ('00000000-0000-0000-0000-0000000007a2');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000007b1', 'DA Org A'), ('00000000-0000-0000-0000-0000000007b2', 'DA Org B');
insert into org_members (org_id, user_id, role) values ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007a1', 'member'), ('00000000-0000-0000-0000-0000000007b2', '00000000-0000-0000-0000-0000000007a2', 'member');

-- Org A: BASE project P1 (ACTIVE) and a second project P2; Org B: project P3
insert into projects (id, org_id, project_reference, name, customer_name, original_contract_cents, tax_rate_bps, status) values
  ('00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007b1', 'DA-1', 'P1', 'Cust', 100000, 1500, 'DRAFT'),
  ('00000000-0000-0000-0000-0000000007c2', '00000000-0000-0000-0000-0000000007b1', 'DA-2', 'P2', 'Cust', 100000, 1500, 'DRAFT'),
  ('00000000-0000-0000-0000-0000000007c3', '00000000-0000-0000-0000-0000000007b2', 'DA-3', 'P3', 'Cust', 100000, 1500, 'DRAFT');
insert into project_stages (id, org_id, project_id, sort_order, name, value_cents) values
  ('00000000-0000-0000-0000-0000000007d1', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', 1, 'Deposit', 40000),
  ('00000000-0000-0000-0000-0000000007d9', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', 2, 'Delivery', 60000),
  ('00000000-0000-0000-0000-0000000007d2', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c2', 1, 'All', 100000),
  ('00000000-0000-0000-0000-0000000007d3', '00000000-0000-0000-0000-0000000007b2', '00000000-0000-0000-0000-0000000007c3', 1, 'All', 100000);

-- ── deliveries ──
insert into project_deliveries (id, org_id, project_id, label, created_by_email) values
  ('00000000-0000-0000-0000-0000000007e1', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', 'Truck 1', 'm@x'),
  ('00000000-0000-0000-0000-0000000007e2', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', 'Truck 2', 'm@x'),
  ('00000000-0000-0000-0000-0000000007e3', '00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c2', 'Truck 1', 'm@x'); -- same label on ANOTHER project is fine
select pg_temp.expect_denied($q$insert into project_deliveries (org_id, project_id, label, created_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','Truck 1','m@x')$q$, 'duplicate delivery label on one project');
select pg_temp.expect_denied($q$insert into project_deliveries (org_id, project_id, label, created_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','  ','m@x')$q$, 'blank delivery label');
select pg_temp.expect_denied($q$insert into project_deliveries (org_id, project_id, label, status, created_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','X','SHIPPED','m@x')$q$, 'unknown delivery status');
select pg_temp.expect_denied($q$insert into project_deliveries (org_id, project_id, label, created_by_email) values ('00000000-0000-0000-0000-0000000007b2','00000000-0000-0000-0000-0000000007c1','Cross','m@x')$q$, 'delivery whose org does not own the project');

-- ── allocations: one row per delivery + SKU; positive quantity; same project/org as the delivery ──
insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values
  ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007e1', 'SKU-A', 4, 'm@x'),
  ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007e2', 'SKU-A', 6, 'm@x'); -- split across deliveries
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1','SKU-A',1,'m@x')$q$, 'second row for the same delivery and SKU');
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1','SKU-B',0,'m@x')$q$, 'zero quantity');
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1','SKU-B',-2,'m@x')$q$, 'negative quantity');
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1',' ',1,'m@x')$q$, 'blank SKU');
-- isolation: an allocation cannot attach a delivery of P1 to project P2 or to another org
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c2','00000000-0000-0000-0000-0000000007e1','SKU-C',1,'m@x')$q$, 'allocation on a different project than its delivery');
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b2','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1','SKU-C',1,'m@x')$q$, 'allocation on a different org than its delivery');
-- fractional quantities (e.g. metres) are allowed
insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007e1', 'SKU-M', 12.5, 'm@x');
update project_delivery_allocations set quantity = 5 where delivery_id = '00000000-0000-0000-0000-0000000007e1' and sku = 'SKU-A';
do $$ begin
  if (select quantity from project_delivery_allocations where delivery_id = '00000000-0000-0000-0000-0000000007e1' and sku = 'SKU-A') <> 5 then raise exception 'allocation update lost'; end if;
  if (select sum(quantity) from project_delivery_allocations where project_id = '00000000-0000-0000-0000-0000000007c1' and sku = 'SKU-A') <> 11 then raise exception 'allocations of one SKU sum across deliveries'; end if;
  if (select count(*) from project_delivery_allocations where project_id = '00000000-0000-0000-0000-0000000007c2') <> 0 then raise exception 'P2 must not see P1 allocations (independent scopes)'; end if;
end $$;

-- ── a cancelled delivery cannot hold (new or re-pointed) allocations ──
update project_deliveries set status = 'CANCELLED' where id = '00000000-0000-0000-0000-0000000007e2';
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e2','SKU-Z',1,'m@x')$q$, 'allocation on a cancelled delivery');
select pg_temp.expect_denied($q$update project_delivery_allocations set quantity = 9 where delivery_id = '00000000-0000-0000-0000-0000000007e2'$q$, 'update an allocation on a cancelled delivery');

-- ── append-only audit ──
insert into project_delivery_events (org_id, project_id, delivery_id, sku, action, from_quantity, to_quantity, reason, actor_email)
values ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007e1', 'SKU-A', 'ALLOCATION_SET', 0, 4, 'first load', 'm@x');
select pg_temp.expect_denied($q$insert into project_delivery_events (org_id, project_id, delivery_id, action, actor_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1','DELETED_EVERYTHING','m@x')$q$, 'unknown audit action');
select pg_temp.expect_denied($q$update project_delivery_events set reason = 'rewritten'$q$, 'rewrite an audit row');
select pg_temp.expect_denied($q$delete from project_delivery_events$q$, 'delete an audit row');

-- ── milestone confirmations: need a note, the stage must belong to the same project/org, history is append-only ──
insert into project_milestone_confirmations (org_id, project_id, stage_id, confirmed_by_email, note, evidence_ref)
values ('00000000-0000-0000-0000-0000000007b1', '00000000-0000-0000-0000-0000000007c1', '00000000-0000-0000-0000-0000000007d9', 'm@x', 'About 90% delivered, signed POD', 'POD-1');
select pg_temp.expect_denied($q$insert into project_milestone_confirmations (org_id, project_id, stage_id, confirmed_by_email, note) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007d9','m@x',' ')$q$, 'blank confirmation note');
select pg_temp.expect_denied($q$insert into project_milestone_confirmations (org_id, project_id, stage_id, confirmed_by_email, note) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007d2','m@x','stage of another project')$q$, 'confirm a stage that belongs to another project');
select pg_temp.expect_denied($q$update project_milestone_confirmations set note = 'rewritten'$q$, 'rewrite a confirmation');
select pg_temp.expect_denied($q$delete from project_milestone_confirmations$q$, 'delete a confirmation');
-- a confirmation does not touch the claim engine: no claim, stage or progress row changed
do $$ begin
  if (select count(*) from project_claims where project_id = '00000000-0000-0000-0000-0000000007c1') <> 0 then raise exception 'confirmation must not create claims'; end if;
end $$;

-- client roles hold SELECT only on these tables (RLS aside): no INSERT/UPDATE/DELETE/TRUNCATE grant for anon or authenticated
do $$ begin
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name in ('project_milestone_confirmations','project_deliveries','project_delivery_allocations','project_delivery_events') and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT') then
    raise exception '0107: anon/authenticated must hold SELECT only';
  end if;
  if exists (select 1 from information_schema.role_table_grants where table_schema = 'public' and table_name in ('project_milestone_confirmations','project_deliveries','project_delivery_allocations','project_delivery_events') and grantee = 'anon') then
    raise exception '0107: anon must hold no privilege at all';
  end if;
end $$;
-- ── RLS ──
select pg_temp.act_as('00000000-0000-0000-0000-0000000007a1');
do $$ begin
  if (select count(*) from project_deliveries) <> 3 then raise exception 'member A should see org A deliveries (3), saw %', (select count(*) from project_deliveries); end if;
  if (select count(*) from project_delivery_allocations) <> 3 then raise exception 'member A should see org A allocations'; end if;
  if (select count(*) from project_delivery_events) <> 1 then raise exception 'member A should see the audit row'; end if;
  if (select count(*) from project_milestone_confirmations) <> 1 then raise exception 'member A should see the confirmation'; end if;
end $$;
select pg_temp.expect_no_rows_changed($q$update project_deliveries set label = 'hacked'$q$, 'member update delivery');
select pg_temp.expect_no_rows_changed($q$update project_delivery_allocations set quantity = 999$q$, 'member update allocation');
select pg_temp.expect_no_rows_changed($q$delete from project_delivery_allocations$q$, 'member delete allocation');
select pg_temp.expect_denied($q$insert into project_deliveries (org_id, project_id, label, created_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','Member made','m@x')$q$, 'member insert delivery');
select pg_temp.expect_denied($q$insert into project_delivery_allocations (org_id, project_id, delivery_id, sku, quantity, updated_by_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1','SKU-Q',1,'m@x')$q$, 'member insert allocation');
select pg_temp.expect_denied($q$insert into project_milestone_confirmations (org_id, project_id, stage_id, confirmed_by_email, note) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007d9','m@x','member made')$q$, 'member insert confirmation');
select pg_temp.expect_denied($q$insert into project_delivery_events (org_id, project_id, delivery_id, action, actor_email) values ('00000000-0000-0000-0000-0000000007b1','00000000-0000-0000-0000-0000000007c1','00000000-0000-0000-0000-0000000007e1','DELIVERY_CREATED','m@x')$q$, 'member insert audit row');
select pg_temp.reset_role();
select pg_temp.act_as('00000000-0000-0000-0000-0000000007a2');
do $$ begin
  if (select count(*) from project_deliveries) <> 0 then raise exception 'org B must not see org A deliveries'; end if;
  if (select count(*) from project_delivery_allocations) <> 0 then raise exception 'org B must not see org A allocations'; end if;
  if (select count(*) from project_delivery_events) <> 0 then raise exception 'org B must not see org A audit'; end if;
  if (select count(*) from project_milestone_confirmations) <> 0 then raise exception 'org B must not see org A confirmations'; end if;
end $$;
select pg_temp.reset_role();

-- ── cascade: deleting the project removes its plan and its audit (the append-only guard only protects live projects) ──
delete from projects where id = '00000000-0000-0000-0000-0000000007c1';
do $$ begin
  if (select count(*) from project_deliveries where project_id = '00000000-0000-0000-0000-0000000007c1') <> 0
     or (select count(*) from project_delivery_events where project_id = '00000000-0000-0000-0000-0000000007c1') <> 0
     or (select count(*) from project_milestone_confirmations where project_id = '00000000-0000-0000-0000-0000000007c1') <> 0 then
    raise exception 'project delete must cascade to deliveries, audit and confirmations';
  end if;
end $$;

select 'ALL 0107 PROJECT DELIVERY ALLOCATION AND MILESTONE TESTS PASSED' as result;
rollback;
