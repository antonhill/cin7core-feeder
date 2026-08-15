-- Transactional test for migration 0062's Ready to Invoice columns on
-- report_order_fulfillment(_lines). BEGIN/ROLLBACK: safe against any DB with
-- 0062 applied, leaves no rows. Covers the brief's own named edge cases:
-- multi-fulfilment summing, a re-qualifying voided invoice, partial pack,
-- fully-invoiced-but-not-shipped (must not appear), an unauthorised pack not
-- counting, a DRAFT invoice not counting, and the P5.3 date floor applying
-- here too (is_ready_to_invoice / ready_to_invoice_hidden_by_floor). Expect
-- it to print "ALL 0062 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-000000000801', 'Ready To Invoice Test Org');

insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted, fulfilment_view_start_date)
  values ('00000000-0000-0000-0000-000000000802', '00000000-0000-0000-0000-000000000801', 'Unfloored', 'acct-r1', 'enc-r1', null);
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted, fulfilment_view_start_date)
  values ('00000000-0000-0000-0000-000000000803', '00000000-0000-0000-0000-000000000801', 'Floored', 'acct-r2', 'enc-r2', '2026-01-01');

insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, ship_by, order_date, combined_picking_status, combined_shipping_status)
values
  -- 1: two fulfilments' authorised packs sum to 10, one partial invoice for 6 -> 4 ready.
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-1', 'SO-1', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 2: fully packed+authorised, its only invoice is VOIDED -> re-qualifies, fully ready.
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-2', 'SO-2', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 3: only 3 of 10 ordered actually packed+authorised -> ready reflects the packed portion only.
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-3', 'SO-3', 'Cust', '2026-06-01', '2026-05-01', 'PARTIALLY PICKED', 'NOT SHIPPED'),
  -- 4: fully packed AND fully invoiced (AUTHORISED), still NOT SHIPPED -> must NOT appear (shipping-status-independent).
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-4', 'SO-4', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 5: would qualify, but on the FLOORED instance with an old ship_by -> hidden by floor, still returned (All Orders unaffected).
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000803', 'sale-5', 'SO-5', 'Cust', '2025-06-01', '2025-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 6: packed but NOT AUTHORISED -> doesn't count as packed_qty_authorised at all.
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-6', 'SO-6', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED'),
  -- 7: authorised pack, invoice exists but is still DRAFT -> doesn't count as invoiced, fully ready.
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-7', 'SO-7', 'Cust', '2026-06-01', '2026-05-01', 'PICKED', 'NOT SHIPPED');

insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, product_name, quantity, backorder_quantity)
values
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-1', 0, 'SKU-1', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-2', 0, 'SKU-2', 'Widget', 5, 0),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-3', 0, 'SKU-3', 'Widget', 10, 0),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-4', 0, 'SKU-4', 'Widget', 8, 0),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000803', 'sale-5', 0, 'SKU-5', 'Widget', 5, 0),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-6', 0, 'SKU-6', 'Widget', 4, 0),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-7', 0, 'SKU-7', 'Widget', 5, 0);

-- Two fulfilments' worth of authorised pack lines for sale-1 (6 + 4 = 10).
insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
values
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-1', 'pack', 0, 'SKU-1', 6, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-1', 'pack', 1, 'SKU-1', 4, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-2', 'pack', 0, 'SKU-2', 5, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-3', 'pack', 0, 'SKU-3', 3, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-4', 'pack', 0, 'SKU-4', 8, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000803', 'sale-5', 'pack', 0, 'SKU-5', 5, 'AUTHORISED'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-6', 'pack', 0, 'SKU-6', 4, 'NOT AVAILABLE'),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-7', 'pack', 0, 'SKU-7', 5, 'AUTHORISED');

insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, invoice_status, product_sku, quantity)
values
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-1', 'INV-1', 0, 'AUTHORISED', 'SKU-1', 6),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-2', 'INV-2', 0, 'VOIDED', 'SKU-2', 5),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-4', 'INV-4', 0, 'AUTHORISED', 'SKU-4', 8),
  ('00000000-0000-0000-0000-000000000801', '00000000-0000-0000-0000-000000000802', 'sale-7', 'INV-7', 0, 'DRAFT', 'SKU-7', 5);

do $$
declare
  org uuid := '00000000-0000-0000-0000-000000000801';
  r record;
  by_id jsonb := '{}'::jsonb;
begin
  for r in select * from report_order_fulfillment(org, null) loop
    by_id := by_id || jsonb_build_object(
      r.cin7_sale_id,
      jsonb_build_object(
        'total_ready_to_invoice_qty', r.total_ready_to_invoice_qty,
        'is_ready_to_invoice', r.is_ready_to_invoice,
        'hidden', r.ready_to_invoice_hidden_by_floor
      )
    );
  end loop;

  if (select count(*) from jsonb_object_keys(by_id)) is distinct from 7 then
    raise exception 'expected all 7 sales to still be returned (All Orders ignores the floor), got: %', by_id;
  end if;

  if (by_id->'sale-1'->>'total_ready_to_invoice_qty')::numeric is distinct from 4
    or (by_id->'sale-1'->>'is_ready_to_invoice')::boolean is not true
  then raise exception 'sale-1 (2 fulfilments packed=10, invoiced=6) should be ready for 4, got %', by_id->'sale-1'; end if;

  if (by_id->'sale-2'->>'total_ready_to_invoice_qty')::numeric is distinct from 5
    or (by_id->'sale-2'->>'is_ready_to_invoice')::boolean is not true
  then raise exception 'sale-2 (voided invoice should not count, re-qualifying) should be ready for 5, got %', by_id->'sale-2'; end if;

  if (by_id->'sale-3'->>'total_ready_to_invoice_qty')::numeric is distinct from 3
  then raise exception 'sale-3 (partial pack: 3 of 10 ordered) should be ready for only the packed 3, got %', by_id->'sale-3'; end if;

  if (by_id->'sale-4'->>'total_ready_to_invoice_qty')::numeric is distinct from 0
    or (by_id->'sale-4'->>'is_ready_to_invoice')::boolean is not false
  then raise exception 'sale-4 (fully packed AND fully invoiced, still NOT SHIPPED) must NOT appear, got %', by_id->'sale-4'; end if;

  if (by_id->'sale-5'->>'is_ready_to_invoice')::boolean is not false
    or (by_id->'sale-5'->>'hidden')::boolean is not true
    or (by_id->'sale-5'->>'total_ready_to_invoice_qty')::numeric is distinct from 5
  then raise exception 'sale-5 (would qualify, hidden by the floored instance date floor) should be hidden but still totalled, got %', by_id->'sale-5'; end if;

  if (by_id->'sale-6'->>'total_ready_to_invoice_qty')::numeric is distinct from 0
  then raise exception 'sale-6 (packed but NOT AUTHORISED) should not count toward ready-to-invoice, got %', by_id->'sale-6'; end if;

  if (by_id->'sale-7'->>'total_ready_to_invoice_qty')::numeric is distinct from 5
    or (by_id->'sale-7'->>'is_ready_to_invoice')::boolean is not true
  then raise exception 'sale-7 (invoice still DRAFT) should not count as invoiced, fully ready for 5, got %', by_id->'sale-7'; end if;
end $$;

do $$ begin raise notice 'ALL 0062 READY-TO-INVOICE ASSERTIONS PASSED'; end $$;

rollback;
