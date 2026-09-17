-- Transactional test for migration 0093 (Warehouse Performance Scorecard
-- bottleneck queues). BEGIN/ROLLBACK: safe against any DB with 0093
-- applied, leaves no rows. Expect it to print "ALL 0093 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000e1', 'Bottleneck Test Org A');
insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000e2', 'Bottleneck Test Org B');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000e1', 'Bottleneck Test Instance A', 'acct-a', 'enc');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000e2', 'Bottleneck Test Instance B', 'acct-b', 'enc');

-- --- Empty org: every queue is zero, not an error, no divide-by-zero --------
do $$
declare
  r record;
  n integer := 0;
begin
  for r in select * from report_scorecard_bottleneck_summary('00000000-0000-0000-0000-0000000000e1'::uuid) loop
    n := n + 1;
    if r.current_count <> 0 then raise exception 'expected 0 orders in queue % for an org with no sales, got %', r.queue, r.current_count; end if;
    if r.oldest_age_days is not null then raise exception 'expected null oldest_age_days for an empty queue %, got %', r.queue, r.oldest_age_days; end if;
  end loop;
  if n <> 4 then raise exception 'expected exactly 4 queue rows from the summary function, got %', n; end if;
end $$;

-- --- Ready to Pick: qualifies on pickable qty + non-terminal picking status -
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000e1';
  inst uuid := '00000000-0000-0000-0000-0000000000e3';
  n integer;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, order_date, combined_picking_status, combined_shipping_status)
    values (org, inst, 'RTP-1', 'SO-RTP-1', 'Customer A', current_date - 2, 'NOT PICKED', 'NOT SHIPPED');
  insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, quantity, backorder_quantity)
    values (org, inst, 'RTP-1', 1, 'SKU-1', 10, 0);

  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'RTP-1' and qualifies_ready_to_pick;
  if n <> 1 then raise exception 'RTP-1 should qualify for Ready to Pick (pickable qty 10, status NOT PICKED)'; end if;

  -- Fully picked -> pickable_qty drops to 0 -> no longer qualifies.
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity)
    values (org, inst, 'RTP-1', 'pick', 1, 'SKU-1', 10);
  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'RTP-1' and qualifies_ready_to_pick;
  if n <> 0 then raise exception 'RTP-1 should no longer qualify for Ready to Pick once fully picked'; end if;

  -- A PICKED sale with remaining pickable qty (a real but perhaps stale
  -- combination) must NOT qualify — status excludes it regardless of qty.
  update sales set combined_picking_status = 'PICKED' where org_id = org and cin7_sale_id = 'RTP-1';
  delete from sale_pick_pack_lines where org_id = org and cin7_sale_id = 'RTP-1';
  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'RTP-1' and qualifies_ready_to_pick;
  if n <> 0 then raise exception 'a PICKED sale must not qualify for Ready to Pick regardless of pickable qty'; end if;
end $$;

-- --- Packed but Not Invoiced: qualifies on AUTHORISED-pack qty minus invoiced qty
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000e1';
  inst uuid := '00000000-0000-0000-0000-0000000000e3';
  n integer;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, order_date, invoice_amount)
    values (org, inst, 'PNI-1', 'SO-PNI-1', 'Customer B', current_date - 3, 500);
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
    values (org, inst, 'PNI-1', 'pack', 1, 'SKU-2', 5, 'AUTHORISED');

  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'PNI-1' and qualifies_packed_not_invoiced;
  if n <> 1 then raise exception 'PNI-1 should qualify for Packed but Not Invoiced (5 packed-authorised, 0 invoiced)'; end if;

  -- Fully invoiced -> the remainder drops to 0 -> no longer qualifies.
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, invoice_status, invoice_date)
    values (org, inst, 'PNI-1', 'INV-1', 1, 'SKU-2', 5, 'AUTHORISED', current_date - 1);
  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'PNI-1' and qualifies_packed_not_invoiced;
  if n <> 0 then raise exception 'PNI-1 should no longer qualify once fully invoiced'; end if;

  -- A DRAFT invoice (not AUTHORISED/PAID) must not count as invoiced.
  update sale_lines set invoice_status = 'DRAFT' where org_id = org and cin7_sale_id = 'PNI-1';
  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'PNI-1' and qualifies_packed_not_invoiced;
  if n <> 1 then raise exception 'a DRAFT invoice must not count as invoiced for Packed but Not Invoiced'; end if;
end $$;

-- --- Invoiced but Not Shipped: qualifies on invoiced qty + non-terminal shipping status
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000e1';
  inst uuid := '00000000-0000-0000-0000-0000000000e3';
  n integer;
  age integer;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, order_date, combined_shipping_status)
    values (org, inst, 'INS-1', 'SO-INS-1', 'Customer C', current_date - 10, 'NOT SHIPPED');
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, invoice_status, invoice_date)
    values (org, inst, 'INS-1', 'INV-2', 1, 'SKU-3', 4, 'PAID', current_date - 2);

  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'INS-1' and qualifies_invoiced_not_shipped;
  if n <> 1 then raise exception 'INS-1 should qualify for Invoiced but Not Shipped'; end if;

  -- Ages from the latest real INVOICE date (2 days ago), not order_date (10
  -- days ago) — this is the queue with genuine "when was it invoiced"
  -- evidence available, unlike Packed but Not Invoiced (see 0093's header).
  select age_days into age from report_scorecard_bottleneck_orders(org, 'invoiced_not_shipped') where cin7_sale_id = 'INS-1';
  if age <> 2 then raise exception 'INS-1 age should be 2 (days since invoice_date), got %', age; end if;

  -- Shipped -> no longer qualifies, regardless of invoiced qty.
  update sales set combined_shipping_status = 'SHIPPED' where org_id = org and cin7_sale_id = 'INS-1';
  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'INS-1' and qualifies_invoiced_not_shipped;
  if n <> 0 then raise exception 'a SHIPPED sale must not qualify for Invoiced but Not Shipped'; end if;
end $$;

-- --- Backorders Awaiting Stock: qualifies on backorder qty; no PO data -> has_open_po = false
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000e1';
  inst uuid := '00000000-0000-0000-0000-0000000000e3';
  n integer;
  has_po boolean;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, order_date)
    values (org, inst, 'BO-1', 'SO-BO-1', 'Customer D', current_date - 5);
  insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, quantity, backorder_quantity)
    values (org, inst, 'BO-1', 1, 'SKU-4', 20, 8);

  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'BO-1' and qualifies_backorder_awaiting_stock;
  if n <> 1 then raise exception 'BO-1 should qualify for Backorders Awaiting Stock (backorder qty 8)'; end if;

  -- No purchase_order_lines/purchases rows exist anywhere in this test ->
  -- has_open_po must default to false, not error.
  select has_open_po into has_po from report_scorecard_bottleneck_orders(org, 'backorders_awaiting_stock') where cin7_sale_id = 'BO-1';
  if has_po is distinct from false then raise exception 'has_open_po should default to false when no purchase data exists, got %', has_po; end if;

  -- Zero backorder qty -> no longer qualifies.
  update sale_order_lines set backorder_quantity = 0 where org_id = org and cin7_sale_id = 'BO-1';
  select count(*) into n from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'BO-1' and qualifies_backorder_awaiting_stock;
  if n <> 0 then raise exception 'BO-1 should no longer qualify once its backorder qty is zero'; end if;
end $$;

-- --- A null ship_by must not error any predicate or ordering -----------------
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000e1';
  inst uuid := '00000000-0000-0000-0000-0000000000e3';
  n integer;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, order_date, ship_by, combined_picking_status)
    values (org, inst, 'NOSHIPBY-1', 'SO-NOSHIPBY-1', 'Customer E', current_date - 1, null, 'NOT PICKED');
  insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, quantity, backorder_quantity)
    values (org, inst, 'NOSHIPBY-1', 1, 'SKU-5', 3, 0);

  select count(*) into n from report_scorecard_bottleneck_orders(org, 'ready_to_pick');
  if n < 1 then raise exception 'a null ship_by must not prevent the order from appearing in a queue'; end if;
end $$;

-- --- Org isolation: org B's summary/drill-down never sees org A's orders ----
do $$
declare
  n integer;
begin
  select count(*) into n from report_scorecard_bottleneck_orders('00000000-0000-0000-0000-0000000000e2'::uuid, 'ready_to_pick');
  if n <> 0 then raise exception 'org B should see 0 Ready to Pick orders (all test data belongs to org A), got %', n; end if;

  select sum(current_count) into n from report_scorecard_bottleneck_summary('00000000-0000-0000-0000-0000000000e2'::uuid);
  if coalesce(n, 0) <> 0 then raise exception 'org B''s bottleneck summary should be entirely zero, got total %', n; end if;
end $$;

do $$ begin raise notice 'ALL 0093 WAREHOUSE PERFORMANCE BOTTLENECK QUEUE TESTS PASSED'; end $$;

rollback;
