-- Transactional test for migration 0127 (Toolbox cost / margin confidentiality). BEGIN/ROLLBACK - leaves no rows.
-- Proves, as REAL database roles with REAL JWT claims (set role + request.jwt.claims), that:
--   * a Rep-like member, an estimator-like member, an organisation admin, a member of ANOTHER organisation and ANON cannot read (select * or by sensitive column), insert, update, delete or TRUNCATE
--     any of the nine cost / margin tables (SQLSTATE 42501) and cannot execute the cost / margin report functions;
--   * RLS is independently default-deny (no policies): even if SELECT were re-granted, no row is visible;
--   * the SERVICE ROLE (the application's only path) still reads and writes every table and still runs the report functions and recompute_product_hash;
--   * unrelated Toolbox tables keep their client access;
--   * catalogue guard: ANY public table matching the cost-table names (present or added by a later migration) carries no client privilege and no policy.
begin;

create or replace function pg_temp.as_user(uid uuid, mail text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated', 'email', mail)::text, true);
end $$;
create or replace function pg_temp.as_role(r text) returns void language plpgsql as $$
begin perform set_config('role', r, true); end $$;
-- the statement must fail with SQLSTATE 42501 (insufficient_privilege)
create or replace function pg_temp.expect_42501(sql text, label text) returns void language plpgsql as $$
declare st text;
begin
  begin execute sql; exception when others then get stacked diagnostics st = returned_sqlstate; if st = '42501' then return; end if; raise exception 'WRONG ERROR (%) for %, expected 42501 permission denied', st, label; end;
  raise exception 'EXPECTED permission denied but succeeded: %', label;
end $$;

-- ── fixtures (as the table owner) ───────────────────────────────────────────
insert into auth.users (id) values
  ('00000000-0000-0000-0000-0000000027a1'), ('00000000-0000-0000-0000-0000000027a2'), ('00000000-0000-0000-0000-0000000027a3'),
  ('00000000-0000-0000-0000-0000000027a4'), ('00000000-0000-0000-0000-0000000027a5');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000027b1', 'CC Org A'), ('00000000-0000-0000-0000-0000000027b2', 'CC Org B');
insert into org_members (org_id, user_id, role) values
  ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027a1', 'member'),   -- Rep-like
  ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027a2', 'member'),   -- estimator-like
  ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027a3', 'owner'),    -- owner
  ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027a4', 'admin'),    -- organisation admin
  ('00000000-0000-0000-0000-0000000027b2', '00000000-0000-0000-0000-0000000027a5', 'member');   -- other organisation
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000027e1', '00000000-0000-0000-0000-0000000027b1', 'CC Instance', 'acct', 'enc');

insert into products (org_id, sku, name, average_cost, supplier_fixed_price)
  values ('00000000-0000-0000-0000-0000000027b1', 'CC-SKU-1', 'CC Product 1', 12.5, 9.75);
insert into assembly_bom_lines (org_id, product_sku, component_sku, quantity, estimated_unit_cost, cost_percentage)
  values ('00000000-0000-0000-0000-0000000027b1', 'CC-SKU-1', 'CC-COMP-1', 2, 3.5, 50);
insert into production_bom_versions (org_id, product_sku, version) values ('00000000-0000-0000-0000-0000000027b1', 'CC-SKU-1', 'v1');
insert into production_bom_operations (org_id, product_sku, version, operation_sequence, operation_type)
  values ('00000000-0000-0000-0000-0000000027b1', 'CC-SKU-1', 'v1', '10', 'Operation');
insert into production_bom_items (org_id, product_sku, version, operation_sequence, item_type, item_code, quantity, cost_of_wastage, cost_allocation_type, resource_cost_type)
  values ('00000000-0000-0000-0000-0000000027b1', 'CC-SKU-1', 'v1', '10', 'Component', 'CC-COMP-1', 1, 4.25, 'Percent', 'Fixed');
insert into sales (org_id, instance_id, cin7_sale_id, invoice_date, customer_name, location)
  values ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027e1', 'CC-SALE-1', current_date, 'CC Customer', 'Main');
insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, invoice_date, product_sku, product_name, quantity, price, total, average_cost)
  values ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027e1', 'CC-SALE-1', 'CC-INV-1', 1, current_date, 'CC-SKU-1', 'CC Product 1', 2, 20, 40, 12.5);
insert into assembly_builds (org_id, instance_id, cin7_task_id, product_sku, status, quantity, completion_date)
  values ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027e1', 'CC-TASK-1', 'CC-SKU-1', 'COMPLETED', 1, current_date);
insert into assembly_consumption_lines (org_id, instance_id, cin7_task_id, line_number, product_sku, quantity, unit_cost)
  values ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027e1', 'CC-TASK-1', 1, 'CC-COMP-1', 2, 3.5);
insert into production_orders (org_id, instance_id, cin7_production_order_id, order_number, list_status, wip_account, wip_actual_cost)
  values ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027e1', 'CC-PO-1', 'MO-1', 'IN PROGRESS', '1400', 321.5);
insert into production_operations (org_id, instance_id, cin7_production_order_id, operation_order, actual_resource_cost, actual_material_cost, wastage_qty)
  values ('00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027e1', 'CC-PO-1', 1, 100.5, 221, 1);
insert into quotes (id, org_id, instance_id, estimated_cost, margin_revenue_ex_tax, overall_margin_pct)
  values ('00000000-0000-0000-0000-0000000027c1', '00000000-0000-0000-0000-0000000027b1', '00000000-0000-0000-0000-0000000027e1', 100, 150, 33.33);
insert into quote_lines (quote_id, org_id, line_number, product_sku, quantity, unit_price, average_cost, estimated_cost, margin_pct)
  values ('00000000-0000-0000-0000-0000000027c1', '00000000-0000-0000-0000-0000000027b1', 1, 'CC-SKU-1', 2, 75, 50, 100, 33.33);
insert into activity_log (org_id, action, summary) values ('00000000-0000-0000-0000-0000000027b1', 'sync.products', 'toolbox row');

-- ── 1. catalogue guard (also covers FUTURE tables matching the cost-table names) ──
do $$
declare t record; p text; n int := 0; f record; nf int := 0;
begin
  for t in select c.oid, c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p')
           and c.relname ~ '^(quote_lines|quotes|sale_lines|assembly_bom_lines|assembly_consumption_lines|production_bom_items|production_operations|production_orders|products)$' loop
    n := n + 1;
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] loop
      if has_table_privilege('anon', t.oid, p) then raise exception '0127: anon holds % on %', p, t.relname; end if;
      if has_table_privilege('authenticated', t.oid, p) then raise exception '0127: authenticated holds % on %', p, t.relname; end if;
    end loop;
    if exists (select 1 from pg_attribute a, aclexplode(a.attacl) x where a.attrelid = t.oid and a.attnum > 0 and a.attacl is not null
               and x.grantee in (0, (select oid from pg_roles where rolname = 'anon'), (select oid from pg_roles where rolname = 'authenticated'))) then
      raise exception '0127: a client role holds a column privilege on %', t.relname; end if;
    if exists (select 1 from pg_class c2, aclexplode(coalesce(c2.relacl, acldefault('r', c2.relowner))) a where c2.oid = t.oid and a.grantee = 0) then raise exception '0127: PUBLIC holds a privilege on %', t.relname; end if;
    if not (select relrowsecurity from pg_class where oid = t.oid) then raise exception '0127: RLS must stay enabled on %', t.relname; end if;
    if exists (select 1 from pg_policies where schemaname = 'public' and tablename = t.relname) then raise exception '0127: % must carry no policy (default deny)', t.relname; end if;
    foreach p in array array['SELECT','INSERT','UPDATE','DELETE'] loop
      if not has_table_privilege('service_role', t.oid, p) then raise exception '0127: service_role must keep % on %', p, t.relname; end if;
    end loop;
  end loop;
  if n < 9 then raise exception '0127: the table guard saw only % of 9 tables - the name pattern no longer matches', n; end if;

  for f in select p2.oid, p2.oid::regprocedure::text as sig from pg_proc p2 where p2.pronamespace = 'public'::regnamespace and p2.prokind = 'f'
           and p2.proname in ('report_sales_by_product','report_sales_pivot','report_sales_facts','report_reorder','recompute_product_hash') loop
    nf := nf + 1;
    if has_function_privilege('anon', f.oid, 'EXECUTE') then raise exception '0127: anon can execute %', f.sig; end if;
    if has_function_privilege('authenticated', f.oid, 'EXECUTE') then raise exception '0127: authenticated can execute %', f.sig; end if;
    if exists (select 1 from pg_proc p3, aclexplode(coalesce(p3.proacl, acldefault('f', p3.proowner))) a where p3.oid = f.oid and a.grantee = 0) then raise exception '0127: PUBLIC can execute %', f.sig; end if;
    if not has_function_privilege('service_role', f.oid, 'EXECUTE') then raise exception '0127: service_role must keep EXECUTE on %', f.sig; end if;
  end loop;
  if nf < 5 then raise exception '0127: the function guard saw only % functions (expected at least 5)', nf; end if;
end $$;

-- ── 2. every client role is denied on every cost table (select *, sensitive columns, writes, TRUNCATE) and on the report functions ──
create or replace function pg_temp.deny_everything(label text) returns void language plpgsql as $$
declare t text; c text;
begin
  foreach t in array array['products','quotes','quote_lines','sale_lines','assembly_bom_lines','assembly_consumption_lines','production_bom_items','production_operations','production_orders'] loop
    perform pg_temp.expect_42501(format('select * from %I', t), label || ' select * ' || t);
    perform pg_temp.expect_42501(format('select count(*) from %I', t), label || ' count ' || t);
    perform pg_temp.expect_42501(format('insert into %I default values', t), label || ' insert ' || t);
    perform pg_temp.expect_42501(format('delete from %I', t), label || ' delete ' || t);
    perform pg_temp.expect_42501(format('truncate %I', t), label || ' truncate ' || t);
  end loop;
  -- the specific secrets, by column, the way PostgREST would ask for them
  foreach c in array array['products.average_cost','products.supplier_fixed_price','products.costing_method',
    'quotes.estimated_cost','quotes.margin_revenue_ex_tax','quotes.overall_margin_pct','quotes.margin_scope','quotes.costed_line_count','quotes.excluded_from_margin_count',
    'quote_lines.average_cost','quote_lines.estimated_cost','quote_lines.margin_pct','quote_lines.margin_included','quote_lines.unit_price','quote_lines.cost_snapshot_at',
    'sale_lines.average_cost','sale_lines.price',
    'assembly_bom_lines.estimated_unit_cost','assembly_bom_lines.cost_percentage','assembly_bom_lines.wastage_percent','assembly_bom_lines.wastage_quantity',
    'assembly_consumption_lines.unit_cost',
    'production_bom_items.cost_of_wastage','production_bom_items.cost_allocation_type','production_bom_items.resource_cost_type','production_bom_items.wastage_percent','production_bom_items.wastage_quantity',
    'production_operations.actual_resource_cost','production_operations.actual_material_cost','production_operations.wastage_qty',
    'production_orders.wip_actual_cost','production_orders.wip_account'] loop
    perform pg_temp.expect_42501(format('select %I from %I', split_part(c, '.', 2), split_part(c, '.', 1)), label || ' column ' || c);
  end loop;
  perform pg_temp.expect_42501($q$update products set average_cost = 0$q$, label || ' update products');
  perform pg_temp.expect_42501($q$update quotes set estimated_cost = 0$q$, label || ' update quotes');
  perform pg_temp.expect_42501($q$update production_orders set wip_actual_cost = 0$q$, label || ' update production_orders');
  -- the report functions
  perform pg_temp.expect_42501($q$select * from report_sales_by_product('00000000-0000-0000-0000-0000000027b1'::uuid)$q$, label || ' report_sales_by_product');
  perform pg_temp.expect_42501($q$select * from report_sales_pivot('00000000-0000-0000-0000-0000000027b1'::uuid)$q$, label || ' report_sales_pivot');
  perform pg_temp.expect_42501($q$select * from report_sales_facts('00000000-0000-0000-0000-0000000027b1'::uuid)$q$, label || ' report_sales_facts');
  perform pg_temp.expect_42501($q$select * from report_reorder('00000000-0000-0000-0000-0000000027b1'::uuid)$q$, label || ' report_reorder');
  perform pg_temp.expect_42501($q$select recompute_product_hash('00000000-0000-0000-0000-0000000027b1'::uuid, 'CC-SKU-1')$q$, label || ' recompute_product_hash');
end $$;

select pg_temp.as_user('00000000-0000-0000-0000-0000000027a1', 'rep@x');         select pg_temp.deny_everything('REP-LIKE MEMBER');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a2', 'est@x');         select pg_temp.deny_everything('ESTIMATOR-LIKE MEMBER');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a3', 'owner@x');       select pg_temp.deny_everything('ORG OWNER');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a4', 'admin@x');       select pg_temp.deny_everything('ORG ADMIN');
select pg_temp.as_role('postgres');
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a5', 'other@x');       select pg_temp.deny_everything('OTHER ORG MEMBER');
select pg_temp.as_role('postgres');
select pg_temp.as_role('anon');                                                  select pg_temp.deny_everything('ANON');
select pg_temp.as_role('postgres');

-- ── 3. defence in depth: RLS alone is default-deny even if SELECT were (wrongly) re-granted ──
create or replace function pg_temp.assert_zero_rows(label text) returns void language plpgsql as $$
declare t text; n bigint;
begin
  foreach t in array array['products','quotes','quote_lines','sale_lines','assembly_bom_lines','assembly_consumption_lines','production_bom_items','production_operations','production_orders'] loop
    execute format('select count(*) from %I', t) into n;
    if n <> 0 then raise exception 'RLS must hide % from % even with SELECT granted (saw % rows)', t, label, n; end if;
  end loop;
end $$;
grant select on products, quotes, quote_lines, sale_lines, assembly_bom_lines, assembly_consumption_lines, production_bom_items, production_operations, production_orders to authenticated, anon;
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a1', 'rep@x');   select pg_temp.assert_zero_rows('a Rep-like member');
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a4', 'admin@x'); select pg_temp.assert_zero_rows('an org admin (the app is the only reader)');
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a5', 'other@x'); select pg_temp.assert_zero_rows('another organisation member');
select pg_temp.as_role('anon');                                            select pg_temp.assert_zero_rows('anon');
select pg_temp.as_role('postgres');
revoke select on products, quotes, quote_lines, sale_lines, assembly_bom_lines, assembly_consumption_lines, production_bom_items, production_operations, production_orders from authenticated, anon;
do $$ begin
  if has_table_privilege('authenticated', 'products', 'SELECT') or has_table_privilege('anon', 'quotes', 'SELECT') then raise exception 'test cleanup revoke failed'; end if;
end $$;

-- ── 4. the SERVICE ROLE (the application's path) reads AND writes every table and still runs the functions ──
select pg_temp.as_role('service_role');
do $$
begin
  if (select average_cost from products where sku = 'CC-SKU-1') <> 12.5 then raise exception 'service role must still read products'; end if;
  if (select count(*) from quotes) <> 1 or (select count(*) from quote_lines) <> 1 then raise exception 'service role must still read quotes / quote_lines'; end if;
  if (select count(*) from sale_lines) <> 1 then raise exception 'service role must still read sale_lines'; end if;
  if (select count(*) from assembly_bom_lines) <> 1 or (select count(*) from assembly_consumption_lines) <> 1 then raise exception 'service role must still read assembly tables'; end if;
  if (select count(*) from production_bom_items) <> 1 or (select count(*) from production_operations) <> 1 or (select count(*) from production_orders) <> 1 then raise exception 'service role must still read production tables'; end if;
  -- report functions
  if (select count(*) from report_sales_by_product('00000000-0000-0000-0000-0000000027b1'::uuid)) <> 1 then raise exception 'service role: report_sales_by_product returned no row'; end if;
  if (select revenue from report_sales_by_product('00000000-0000-0000-0000-0000000027b1'::uuid)) <> 40 then raise exception 'service role: report_sales_by_product revenue wrong'; end if;
  if (select count(*) from report_sales_pivot('00000000-0000-0000-0000-0000000027b1'::uuid)) <> 1 then raise exception 'service role: report_sales_pivot returned no row'; end if;
  if (select count(*) from report_sales_facts('00000000-0000-0000-0000-0000000027b1'::uuid)) <> 1 then raise exception 'service role: report_sales_facts returned no row'; end if;
  perform count(*) from report_reorder('00000000-0000-0000-0000-0000000027b1'::uuid);   -- must simply run (no fixtures for availability)
end $$;
-- writes: one per table (the products update also fires the content-hash trigger, which calls recompute_product_hash as service_role)
update products set name = 'CC Product 1b', average_cost = 13 where sku = 'CC-SKU-1';
select recompute_product_hash('00000000-0000-0000-0000-0000000027b1'::uuid, 'CC-SKU-1');
insert into products (org_id, sku, name, average_cost) values ('00000000-0000-0000-0000-0000000027b1', 'CC-SKU-2', 'CC Product 2', 1);
update quotes set estimated_cost = 101 where id = '00000000-0000-0000-0000-0000000027c1';
update quote_lines set average_cost = 51 where quote_id = '00000000-0000-0000-0000-0000000027c1';
insert into quote_lines (quote_id, org_id, line_number, product_sku, quantity, unit_price) values ('00000000-0000-0000-0000-0000000027c1', '00000000-0000-0000-0000-0000000027b1', 2, 'CC-SKU-2', 1, 5);
update sale_lines set average_cost = 13 where cin7_sale_id = 'CC-SALE-1';
update assembly_bom_lines set estimated_unit_cost = 4 where product_sku = 'CC-SKU-1';
update assembly_consumption_lines set unit_cost = 4 where cin7_task_id = 'CC-TASK-1';
update production_bom_items set cost_of_wastage = 5 where product_sku = 'CC-SKU-1';
update production_operations set actual_resource_cost = 101 where cin7_production_order_id = 'CC-PO-1';
update production_orders set wip_actual_cost = 322 where cin7_production_order_id = 'CC-PO-1';
delete from quote_lines where quote_id = '00000000-0000-0000-0000-0000000027c1' and line_number = 2;
delete from products where sku = 'CC-SKU-2';
select pg_temp.as_role('postgres');
do $$
begin
  if (select average_cost from products where sku = 'CC-SKU-1') <> 13 then raise exception 'service role products write did not land'; end if;
  if (select content_hash from products where sku = 'CC-SKU-1') is null then raise exception 'recompute_product_hash as service role did not set content_hash'; end if;
  if (select estimated_cost from quotes where id = '00000000-0000-0000-0000-0000000027c1') <> 101 then raise exception 'service role quotes write did not land'; end if;
  if (select average_cost from quote_lines where quote_id = '00000000-0000-0000-0000-0000000027c1') <> 51 then raise exception 'service role quote_lines write did not land'; end if;
  if (select count(*) from quote_lines where quote_id = '00000000-0000-0000-0000-0000000027c1') <> 1 then raise exception 'service role quote_lines insert/delete did not land'; end if;
  if (select average_cost from sale_lines where cin7_sale_id = 'CC-SALE-1') <> 13 then raise exception 'service role sale_lines write did not land'; end if;
  if (select estimated_unit_cost from assembly_bom_lines where product_sku = 'CC-SKU-1') <> 4 then raise exception 'service role assembly_bom_lines write did not land'; end if;
  if (select unit_cost from assembly_consumption_lines where cin7_task_id = 'CC-TASK-1') <> 4 then raise exception 'service role assembly_consumption_lines write did not land'; end if;
  if (select cost_of_wastage from production_bom_items where product_sku = 'CC-SKU-1') <> 5 then raise exception 'service role production_bom_items write did not land'; end if;
  if (select actual_resource_cost from production_operations where cin7_production_order_id = 'CC-PO-1') <> 101 then raise exception 'service role production_operations write did not land'; end if;
  if (select wip_actual_cost from production_orders where cin7_production_order_id = 'CC-PO-1') <> 322 then raise exception 'service role production_orders write did not land'; end if;
end $$;

-- ── 5. nothing else changed: unrelated Toolbox tables keep their client read ──
do $$
declare t text;
begin
  foreach t in array array['customers','suppliers','sales','purchases','org_members','organizations','activity_log'] loop
    if to_regclass('public.' || t) is not null and not has_table_privilege('authenticated', 'public.' || t, 'SELECT') then raise exception '0127 must not change client access to %', t; end if;
  end loop;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'activity_log' and policyname = 'org members read activity_log') then raise exception '0127 must not touch the activity_log read policy'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'sales' and policyname = 'org members read sales') then raise exception '0127 must not touch the sales read policy'; end if;
end $$;
select pg_temp.as_user('00000000-0000-0000-0000-0000000027a1', 'rep@x');
do $$ begin
  if (select count(*) from activity_log where action = 'sync.products') <> 1 then raise exception 'a member must still read the Toolbox activity rows of their own organisation'; end if;
  if (select count(*) from sales) <> 1 then raise exception 'a member must still read sales of their own organisation (not covered by 0127)'; end if;
end $$;
select pg_temp.as_role('postgres');

-- ── 6. idempotence of the revoke statements (re-run on a clean state: no error, same result) ──
revoke all on table products, quotes from public, anon, authenticated;
do $$ begin if has_table_privilege('authenticated', 'products', 'SELECT') then raise exception 'still revoked'; end if; end $$;

select 'ALL 0127 TOOLBOX COST CONFIDENTIALITY TESTS PASSED' as result;
rollback;
