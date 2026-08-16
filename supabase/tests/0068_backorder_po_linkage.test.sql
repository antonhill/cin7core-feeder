-- Transactional test for migration 0068's backorder PO-linkage columns on
-- report_order_fulfillment. BEGIN/ROLLBACK: safe against any DB with 0068
-- applied, leaves no rows. Covers: no backorder at all, a backordered line
-- covered by an open PO, a backordered line with no open PO anywhere, and a
-- mixed order with both kinds of lines (should be true/true — the two flags
-- are independent "does at least one line match" checks, not a partition).
-- Expect it to print "ALL P5.2 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-000000001101', 'Backorder PO Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-000000001102', '00000000-0000-0000-0000-000000001101', 'Test', 'acct-bo1', 'enc-bo1');

insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, ship_by, order_date, combined_picking_status, combined_shipping_status)
values
  -- 1: fully pickable, no backorder at all.
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-1', 'SO-1', 'Cust', '2026-06-01', '2026-05-01', 'NOT PICKED', 'NOT SHIPPED'),
  -- 2: backordered line, covered by an open PO.
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-2', 'SO-2', 'Cust', '2026-06-01', '2026-05-01', 'NOT PICKED', 'NOT SHIPPED'),
  -- 3: backordered line, no open PO at all for that SKU.
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-3', 'SO-3', 'Cust', '2026-06-01', '2026-05-01', 'NOT PICKED', 'NOT SHIPPED'),
  -- 4: mixed — one line covered by a PO, another line with none.
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-4', 'SO-4', 'Cust', '2026-06-01', '2026-05-01', 'NOT PICKED', 'NOT SHIPPED');

insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, product_name, quantity, backorder_quantity)
values
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-1', 0, 'SKU-FULFILLABLE', 'Widget', 5, 0),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-2', 0, 'SKU-WITH-PO', 'Widget', 5, 5),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-3', 0, 'SKU-NO-PO', 'Widget', 5, 5),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-4', 0, 'SKU-WITH-PO', 'Widget', 5, 5),
  ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'sale-4', 1, 'SKU-NO-PO', 'Widget', 5, 5);

-- Open PO covering SKU-WITH-PO (used by both sale-2 and sale-4).
insert into purchases (org_id, instance_id, cin7_purchase_id, order_number, combined_receiving_status)
values ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'po-1', 'PO-1', 'NOT RECEIVED');
insert into purchase_order_lines (org_id, instance_id, cin7_purchase_id, line_number, product_sku, quantity)
values ('00000000-0000-0000-0000-000000001101', '00000000-0000-0000-0000-000000001102', 'po-1', 0, 'SKU-WITH-PO', 10);
-- No purchase_receipt_lines row at all -> fully outstanding.

-- No PO at all exists anywhere for SKU-NO-PO.

do $$
declare
  org uuid := '00000000-0000-0000-0000-000000001101';
  r record;
  by_id jsonb := '{}'::jsonb;
begin
  for r in select * from report_order_fulfillment(org, null) loop
    by_id := by_id || jsonb_build_object(
      r.cin7_sale_id,
      jsonb_build_object('with_po', r.has_backorder_with_po, 'no_po', r.has_backorder_no_po)
    );
  end loop;

  if (by_id->'sale-1'->>'with_po')::boolean is not false or (by_id->'sale-1'->>'no_po')::boolean is not false
  then raise exception 'sale-1 (no backorder at all) should be false/false, got %', by_id->'sale-1'; end if;

  if (by_id->'sale-2'->>'with_po')::boolean is not true or (by_id->'sale-2'->>'no_po')::boolean is not false
  then raise exception 'sale-2 (backorder covered by open PO) should be true/false, got %', by_id->'sale-2'; end if;

  if (by_id->'sale-3'->>'with_po')::boolean is not false or (by_id->'sale-3'->>'no_po')::boolean is not true
  then raise exception 'sale-3 (backorder, no open PO) should be false/true, got %', by_id->'sale-3'; end if;

  if (by_id->'sale-4'->>'with_po')::boolean is not true or (by_id->'sale-4'->>'no_po')::boolean is not true
  then raise exception 'sale-4 (mixed lines) should be true/true, got %', by_id->'sale-4'; end if;
end $$;

do $$ begin raise notice 'ALL P5.2 BACKORDER-PO-LINKAGE ASSERTIONS PASSED'; end $$;

rollback;
