-- Transactional test for migrations 0096/0097 (fulfilment-level "Invoiced but
-- Not Shipped" + "shipment state unclear"). BEGIN/ROLLBACK: safe against any DB
-- with 0096+0097 applied, leaves no rows. Expect it to print "ALL 0097 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000f1', 'Ship State Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f1', 'Ship State Test Instance', 'acct-f', 'enc');

-- The view must still be security_invoker after being replaced (0093's leak fix).
do $$
declare opts text[];
begin
  select reloptions into opts from pg_class where relname = 'scorecard_bottleneck_orders_v' and relkind = 'v';
  if opts is null or not ('security_invoker=true' = any(opts)) then
    raise exception 'scorecard_bottleneck_orders_v must stay WITH (security_invoker = true) -- got %', opts;
  end if;
end $$;

-- The summary keeps exactly the four KPI queues; "unclear" is a separate function.
do $$
declare n integer;
begin
  select count(*) into n from report_scorecard_bottleneck_summary('00000000-0000-0000-0000-0000000000f1'::uuid);
  if n <> 4 then raise exception 'summary must still return exactly 4 queue rows, got %', n; end if;
  select count(*) into n from report_scorecard_shipment_unclear_summary('00000000-0000-0000-0000-0000000000f1'::uuid);
  if n <> 1 then raise exception 'unclear summary must return one row even when empty, got %', n; end if;
end $$;

-- SO-19948 acceptance case: invoiced 8, shipped 8, 1 unit backordered, Cin7 label PARTIALLY SHIPPED.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000f1';
  inst uuid := '00000000-0000-0000-0000-0000000000f3';
  r record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, order_date, combined_shipping_status, combined_picking_status)
    values (org, inst, 'ACC-1', 'SO-ACC-1', 'Acceptance', current_date - 28, 'PARTIALLY SHIPPED', 'PARTIALLY PICKED');
  insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, quantity, backorder_quantity)
    values (org, inst, 'ACC-1', 0, 'A', 8, 0), (org, inst, 'ACC-1', 1, 'B', 1, 1);
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status, invoice_date)
    values (org, inst, 'ACC-1', 'INV-ACC', 0, 'A', 8, 800, 'AUTHORISED', current_date - 28);
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status, fulfilment_task_id, fulfilment_number, fulfilment_linked_invoice_number, ship_status, shipped_at)
    values (org, inst, 'ACC-1', 'pick', 0, 'A', 8, 'AUTHORISED', 'ACC-F1', 1, 'INV-ACC', 'AUTHORISED', current_date - 27),
           (org, inst, 'ACC-1', 'pack', 0, 'A', 8, 'AUTHORISED', 'ACC-F1', 1, 'INV-ACC', 'AUTHORISED', current_date - 27);

  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'ACC-1';
  if r.qualifies_invoiced_not_shipped then raise exception 'SO-19948 shape must NOT be in Invoiced but Not Shipped (order label PARTIALLY SHIPPED is not qualification)'; end if;
  if r.ship_outstanding_qty <> 0 then raise exception 'outstanding ship qty must be 0, got %', r.ship_outstanding_qty; end if;
  if r.qualifies_shipment_state_unclear then raise exception 'a confirmed-shipped fulfilment is not unclear'; end if;
  if not r.qualifies_backorder_awaiting_stock or r.backorder_qty <> 1 then raise exception 'SO-19948 shape must be in Backorders Awaiting Stock with qty 1, got % / %', r.qualifies_backorder_awaiting_stock, r.backorder_qty; end if;
end $$;

-- Classification matrix: one invoiced fulfilment per row.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000f1';
  inst uuid := '00000000-0000-0000-0000-0000000000f3';
  c record;
  r record;
  sid text;
begin
  for c in
    select * from (values
      -- label, ship_status, shipped_at is set?, expect outstanding qty, expect unclear?
      ('DRAFT',               'DRAFT',                true,  false, 5, false),
      ('NA',                  'NOT AVAILABLE',        false, false, 5, false),
      ('VOIDED',              'VOIDED',               false, false, 5, false),
      ('NULLSTATE',           null,                   false, false, 0, true),
      ('PARTIAL',             'PARTIALLY AUTHORISED', false, false, 0, true),
      ('AUTHNODATE',          'AUTHORISED',           false, false, 0, true),
      ('UNSEEN',              'SOMETHING NEW',        false, false, 0, true),
      ('SHIPPED',             'AUTHORISED',           true,  true,  0, false)
    ) as t(label, ship_status, dummy1, has_date, exp_qty, exp_unclear)
  loop
    sid := 'MX-' || c.label;
    insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, combined_shipping_status)
      values (org, inst, sid, 'SO-' || sid, current_date - 5,
              -- Deliberately the OPPOSITE of what the label would imply, to prove it is never consulted.
              case when c.exp_qty > 0 then 'SHIPPED' else 'NOT SHIPPED' end);
    insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status, invoice_date)
      values (org, inst, sid, 'INV-' || sid, 0, 'X', 5, 250, 'AUTHORISED', current_date - 4);
    insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status, fulfilment_task_id, fulfilment_number, fulfilment_linked_invoice_number, ship_status, shipped_at)
      values (org, inst, sid, 'pack', 0, 'X', 5, 'AUTHORISED', sid || '-F', 1, 'INV-' || sid, c.ship_status, case when c.has_date then current_date - 3 else null end);

    select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = sid;
    if r.ship_outstanding_qty <> c.exp_qty then raise exception '% (ship_status %): expected outstanding qty %, got %', c.label, c.ship_status, c.exp_qty, r.ship_outstanding_qty; end if;
    if r.qualifies_invoiced_not_shipped <> (c.exp_qty > 0) then raise exception '% : queue qualification mismatch', c.label; end if;
    if r.qualifies_shipment_state_unclear <> c.exp_unclear then raise exception '% (ship_status %): expected unclear %, got %', c.label, c.ship_status, c.exp_unclear, r.qualifies_shipment_state_unclear; end if;
    if c.exp_unclear and r.ship_unclear_qty <> 5 then raise exception '% : unclear qty should be the packed qty 5, got %', c.label, r.ship_unclear_qty; end if;
  end loop;
end $$;

-- Mixed fulfilments: only the unshipped one is outstanding; the shipped one is ignored, qty/age/value are the outstanding fulfilment's own.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000f1';
  inst uuid := '00000000-0000-0000-0000-0000000000f3';
  r record;
  o record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, invoice_amount, combined_shipping_status)
    values (org, inst, 'MIX-1', 'SO-MIX-1', current_date - 30, 9999, 'PARTIALLY SHIPPED');
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status, invoice_date)
    values (org, inst, 'MIX-1', 'INV-OLD', 0, 'A', 10, 1000, 'PAID', current_date - 20),
           (org, inst, 'MIX-1', 'INV-NEW', 0, 'B', 3, 300, 'AUTHORISED', current_date - 2);
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status, fulfilment_task_id, fulfilment_number, fulfilment_linked_invoice_number, ship_status, shipped_at)
    values (org, inst, 'MIX-1', 'pack', 0, 'A', 10, 'AUTHORISED', 'MIX-F1', 1, 'INV-OLD', 'AUTHORISED', current_date - 19),
           (org, inst, 'MIX-1', 'pack', 1, 'B', 3,  'AUTHORISED', 'MIX-F2', 2, 'INV-NEW', 'NOT AVAILABLE', null);

  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'MIX-1';
  if r.ship_outstanding_qty <> 3 then raise exception 'mixed order: outstanding should be 3 (only fulfilment 2), got %', r.ship_outstanding_qty; end if;
  if r.ship_outstanding_value <> 300 then raise exception 'mixed order: value should be the outstanding invoice total 300, not the order amount, got %', r.ship_outstanding_value; end if;

  select * into o from report_scorecard_bottleneck_orders(org, 'invoiced_not_shipped') where cin7_sale_id = 'MIX-1';
  if o.relevant_qty <> 3 then raise exception 'drill-down qty must be the outstanding 3, not invoiced 13, got %', o.relevant_qty; end if;
  if o.age_days <> 2 then raise exception 'drill-down age must be the outstanding fulfilment''s invoice age (2), not the older shipped one, got %', o.age_days; end if;
  if o.invoice_amount <> 300 then raise exception 'drill-down value must be 300, got %', o.invoice_amount; end if;
end $$;

-- A fulfilment whose linked invoice is not AUTHORISED/PAID, or with no linked invoice, is not "invoiced".
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000f1';
  inst uuid := '00000000-0000-0000-0000-0000000000f3';
  n integer;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date) values (org, inst, 'UNINV-1', 'SO-UNINV-1', current_date - 3);
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status)
    values (org, inst, 'UNINV-1', 'INV-D', 0, 'A', 4, 40, 'DRAFT');
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status, fulfilment_task_id, fulfilment_number, fulfilment_linked_invoice_number, ship_status)
    values (org, inst, 'UNINV-1', 'pack', 0, 'A', 4, 'AUTHORISED', 'U-F1', 1, 'INV-D', 'NOT AVAILABLE'),
           (org, inst, 'UNINV-1', 'pack', 1, 'B', 2, 'AUTHORISED', 'U-F2', 2, '',      'NOT AVAILABLE');
  select count(*) into n from scorecard_bottleneck_orders_v
    where org_id = org and cin7_sale_id = 'UNINV-1' and (qualifies_invoiced_not_shipped or qualifies_shipment_state_unclear);
  if n <> 0 then raise exception 'draft-invoiced / unlinked fulfilments must not appear in Invoiced but Not Shipped or unclear'; end if;
end $$;

-- Multi-invoice link ("INV-A,INV-B"): the fulfilment is invoiced, counted ONCE, with both invoices' totals.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000f1';
  inst uuid := '00000000-0000-0000-0000-0000000000f3';
  r record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, combined_shipping_status)
    values (org, inst, 'MULTI-1', 'SO-MULTI-1', current_date - 6, 'NOT SHIPPED');
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status, invoice_date)
    values (org, inst, 'MULTI-1', 'INV-M1', 0, 'A', 2, 20, 'PAID', current_date - 5),
           (org, inst, 'MULTI-1', 'INV-M2', 0, 'A', 3, 30, 'AUTHORISED', current_date - 4);
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status, fulfilment_task_id, fulfilment_number, fulfilment_linked_invoice_number, ship_status)
    values (org, inst, 'MULTI-1', 'pack', 0, 'A', 5, 'AUTHORISED', 'MULTI-F1', 1, 'INV-M1,INV-M2', 'NOT AVAILABLE');
  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'MULTI-1';
  if r.ship_outstanding_qty <> 5 then raise exception 'multi-invoice fulfilment must count its pack qty once (5), got %', r.ship_outstanding_qty; end if;
  if r.ship_outstanding_value <> 50 then raise exception 'multi-invoice value should be both invoice totals (50), got %', r.ship_outstanding_value; end if;
  if r.ship_outstanding_since <> current_date - 5 then raise exception 'multi-invoice age should use the oldest invoice, got %', r.ship_outstanding_since; end if;
end $$;

-- NULL ship_status is "unclear" only while the sale is non-terminal at order level; PARTIALLY AUTHORISED is unclear regardless.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000f1';
  inst uuid := '00000000-0000-0000-0000-0000000000f3';
  c record;
  sid text;
  r record;
begin
  for c in
    select * from (values
      ('NULLTERM', null, 'SHIPPED',     false),
      ('NULLOPEN', null, 'SHIPPING',    true),
      ('PARTTERM', 'PARTIALLY AUTHORISED', 'SHIPPED', true)
    ) as t(label, ship_status, lbl, exp_unclear)
  loop
    sid := 'SC-' || c.label;
    insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, combined_shipping_status) values (org, inst, sid, 'SO-' || sid, current_date - 5, c.lbl);
    insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status, invoice_date)
      values (org, inst, sid, 'INV-' || sid, 0, 'X', 5, 250, 'AUTHORISED', current_date - 4);
    insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status, fulfilment_task_id, fulfilment_number, fulfilment_linked_invoice_number, ship_status)
      values (org, inst, sid, 'pack', 0, 'X', 5, 'AUTHORISED', sid || '-F', 1, 'INV-' || sid, c.ship_status);
    select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = sid;
    if r.qualifies_shipment_state_unclear <> c.exp_unclear then raise exception '% : expected unclear %, got %', c.label, c.exp_unclear, r.qualifies_shipment_state_unclear; end if;
    if r.qualifies_invoiced_not_shipped then raise exception '% : an unclear fulfilment must never count in the queue', c.label; end if;
  end loop;
end $$;

-- Summary: unclear orders are excluded from the queue count and surfaced separately.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000f1';
  q integer;
  u record;
begin
  select current_count into q from report_scorecard_bottleneck_summary(org) where queue = 'invoiced_not_shipped';
  -- Outstanding orders: DRAFT, NA, VOIDED, MIX-1, MULTI-1 = 5. Unclear fulfilments are not counted.
  if q <> 5 then raise exception 'invoiced_not_shipped count should be 5 (unclear and shipped excluded), got %', q; end if;
  select * into u from report_scorecard_shipment_unclear_summary(org);
  -- Matrix: NULLSTATE (NOT SHIPPED label), PARTIAL, AUTHNODATE, UNSEEN + SC-NULLOPEN + SC-PARTTERM = 6 orders / 30 units (SC-NULLTERM is terminal-scoped out).
  if u.current_count <> 6 or u.unclear_qty <> 30 then raise exception 'unclear summary should be 6 orders / 30 units, got % / %', u.current_count, u.unclear_qty; end if;
  select count(*) into q from report_scorecard_bottleneck_orders(org, 'shipment_state_unclear');
  if q <> 6 then raise exception 'unclear drill-down should list 6 orders, got %', q; end if;
end $$;

-- Ship-state columns exist, are nullable, and the table kept its RLS.
do $$
declare n integer;
begin
  select count(*) into n from information_schema.columns
    where table_name = 'sale_pick_pack_lines' and column_name in ('ship_status', 'shipped_at') and is_nullable = 'YES';
  if n <> 2 then raise exception 'ship_status and shipped_at must both exist and be nullable'; end if;
  if not (select relrowsecurity from pg_class where relname = 'sale_pick_pack_lines') then raise exception 'sale_pick_pack_lines must keep RLS enabled'; end if;
end $$;

do $$ begin raise notice 'ALL 0097 FULFILMENT-LEVEL SHIPPING QUEUE TESTS PASSED'; end $$;

rollback;
