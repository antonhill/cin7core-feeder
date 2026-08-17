-- Transactional test for migration 0063's Box Label Queue columns on
-- report_order_fulfillment(_lines). BEGIN/ROLLBACK: safe against any DB with
-- 0063 applied, leaves no rows. Covers: authorised-pack fully invoiced +
-- not shipped (qualifies), the same but SHIPPED (excluded), a PARTIALLY
-- invoiced pack (excluded — the P1/P2 inversion), a local print-state row
-- suppressing an otherwise-qualifying order, invoice_numbers aggregation
-- (final invoices only, DRAFT excluded), invoice_coverage_status's three
-- states, and the date floor applying here too. Expect it to print
-- "ALL 0063 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-000000000901', 'Box Label Test Org');

insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted, fulfilment_view_start_date)
  values ('00000000-0000-0000-0000-000000000902', '00000000-0000-0000-0000-000000000901', 'Unfloored', 'acct-b1', 'enc-b1', null);
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted, fulfilment_view_start_date)
  values ('00000000-0000-0000-0000-000000000903', '00000000-0000-0000-0000-000000000901', 'Floored', 'acct-b2', 'enc-b2', '2026-01-01');

insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, ship_by, order_date, combined_picking_status, combined_shipping_status)
values
  -- 1: authorised pack fully invoiced, NOT SHIPPED -> qualifies.
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-1', 'SO-1', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 2: same as 1 but already SHIPPED -> must NOT appear.
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-2', 'SO-2', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'SHIPPED'),
  -- 3: authorised pack, only PARTIALLY invoiced -> must NOT appear (still P1's territory, not P2's).
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-3', 'SO-3', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 4: would qualify, but a local "label printed" flag already exists -> must NOT appear.
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-4', 'SO-4', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 5: would qualify, but on the FLOORED instance with an old ship_by -> hidden by floor, still returned.
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000903', 'sale-5', 'SO-5', 'Cust', '2025-06-01', '2025-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 6: two invoices (one DRAFT, one AUTHORISED) -> invoice_numbers only lists the final one; fully covered by the AUTHORISED one alone -> qualifies.
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-6', 'SO-6', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 7: nothing invoiced at all -> invoice_coverage_status = not_invoiced.
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-7', 'SO-7', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED');

insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, product_name, quantity, backorder_quantity)
values
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-1', 0, 'SKU-1', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-2', 0, 'SKU-2', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-3', 0, 'SKU-3', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-4', 0, 'SKU-4', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000903', 'sale-5', 0, 'SKU-5', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-6', 0, 'SKU-6', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-7', 0, 'SKU-7', 'Widget', 10, 0);

insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
values
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-1', 'pack', 0, 'SKU-1', 10, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-2', 'pack', 0, 'SKU-2', 10, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-3', 'pack', 0, 'SKU-3', 10, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-4', 'pack', 0, 'SKU-4', 10, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000903', 'sale-5', 'pack', 0, 'SKU-5', 10, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-6', 'pack', 0, 'SKU-6', 10, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-7', 'pack', 0, 'SKU-7', 10, 'AUTHORISED');

insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, invoice_status, product_sku, quantity)
values
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-1', 'INV-1', 0, 'AUTHORISED', 'SKU-1', 10),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-2', 'INV-2', 0, 'AUTHORISED', 'SKU-2', 10),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-3', 'INV-3', 0, 'AUTHORISED', 'SKU-3', 4),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-4', 'INV-4', 0, 'AUTHORISED', 'SKU-4', 10),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000903', 'sale-5', 'INV-5', 0, 'AUTHORISED', 'SKU-5', 10),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-6', 'INV-6-DRAFT', 0, 'DRAFT', 'SKU-6', 3),
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-6', 'INV-6-FINAL', 0, 'AUTHORISED', 'SKU-6', 10);

-- ready_qty_at_mark (migration 0071) must match sale-4's current
-- ready-for-box-label qty (10) to represent "already marked printed at
-- today's exact quantity, nothing changed since" -- leaving it at its
-- default of 0 would make 10 > 0 look like NEW growth and wrongly
-- re-qualify the order (this is exactly what markBoxLabelPrintedAction
-- itself always snapshots at click time; see src/actions/box-label.ts).
insert into box_label_print_state (org_id, instance_id, cin7_sale_id, printed_by_email, ready_qty_at_mark)
values
  ('00000000-0000-0000-0000-000000000901', '00000000-0000-0000-0000-000000000902', 'sale-4', 'dispatch@example.com', 10);

do $$
declare
  org uuid := '00000000-0000-0000-0000-000000000901';
  r record;
  by_id jsonb := '{}'::jsonb;
begin
  for r in select * from report_order_fulfillment(org, null) loop
    by_id := by_id || jsonb_build_object(
      r.cin7_sale_id,
      jsonb_build_object(
        'is_ready_for_box_label', r.is_ready_for_box_label,
        'total_ready_for_box_label_qty', r.total_ready_for_box_label_qty,
        'hidden', r.box_label_hidden_by_floor,
        'invoice_numbers', r.invoice_numbers,
        'invoice_coverage_status', r.invoice_coverage_status,
        'printed_at', r.box_label_printed_at
      )
    );
  end loop;

  if (select count(*) from jsonb_object_keys(by_id)) is distinct from 7 then
    raise exception 'expected all 7 sales to still be returned (All Orders ignores the floor), got: %', by_id;
  end if;

  if (by_id->'sale-1'->>'is_ready_for_box_label')::boolean is not true
    or (by_id->'sale-1'->>'total_ready_for_box_label_qty')::numeric is distinct from 10
  then raise exception 'sale-1 (fully invoiced pack, not shipped) should qualify for 10, got %', by_id->'sale-1'; end if;

  if (by_id->'sale-2'->>'is_ready_for_box_label')::boolean is not false
  then raise exception 'sale-2 (fully invoiced pack, already SHIPPED) must NOT appear, got %', by_id->'sale-2'; end if;

  if (by_id->'sale-3'->>'is_ready_for_box_label')::boolean is not false
  then raise exception 'sale-3 (only partially invoiced, 4 of 10 packed) must NOT appear, got %', by_id->'sale-3'; end if;

  if (by_id->'sale-4'->>'is_ready_for_box_label')::boolean is not false
    or (by_id->'sale-4'->>'printed_at') is null
  then raise exception 'sale-4 (local label-printed flag already set) must NOT appear and should report printed_at, got %', by_id->'sale-4'; end if;

  if (by_id->'sale-5'->>'is_ready_for_box_label')::boolean is not false
    or (by_id->'sale-5'->>'hidden')::boolean is not true
  then raise exception 'sale-5 (would qualify, hidden by the floored instance) should be hidden but flagged, got %', by_id->'sale-5'; end if;

  if (by_id->'sale-6'->>'is_ready_for_box_label')::boolean is not true
    or (by_id->'sale-6'->>'invoice_numbers') is distinct from 'INV-6-FINAL'
  then raise exception 'sale-6 (one DRAFT + one AUTHORISED invoice) should qualify and list only the final invoice number, got %', by_id->'sale-6'; end if;

  if (by_id->'sale-1'->>'invoice_coverage_status') is distinct from 'invoiced'
  then raise exception 'sale-1 should be fully invoice_coverage_status=invoiced, got %', by_id->'sale-1'; end if;
  if (by_id->'sale-3'->>'invoice_coverage_status') is distinct from 'partially_invoiced'
  then raise exception 'sale-3 should be invoice_coverage_status=partially_invoiced, got %', by_id->'sale-3'; end if;
  if (by_id->'sale-7'->>'invoice_coverage_status') is distinct from 'not_invoiced'
  then raise exception 'sale-7 (nothing invoiced) should be invoice_coverage_status=not_invoiced, got %', by_id->'sale-7'; end if;
end $$;

do $$ begin raise notice 'ALL 0063 BOX-LABEL-QUEUE ASSERTIONS PASSED'; end $$;

rollback;
