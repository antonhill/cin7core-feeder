-- Transactional test for migration 0100 (Closed / Shipped but Uninvoiced control).
-- BEGIN/ROLLBACK; expect "ALL 0100 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000c1', 'Closed Control Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1', 'Closed Control Test Instance', 'acct-c', 'enc');

do $$
declare opts text[];
begin
  select reloptions into opts from pg_class where relname = 'scorecard_bottleneck_orders_v' and relkind = 'v';
  if opts is null or not ('security_invoker=true' = any(opts)) then
    raise exception 'scorecard_bottleneck_orders_v must stay WITH (security_invoker = true) -- got %', opts;
  end if;
end $$;

-- Membership matrix. Every order packs 10 units (authorised) and invoices 4.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000c1';
  inst uuid := '00000000-0000-0000-0000-0000000000c3';
  c record;
  sid text;
  r record;
begin
  for c in
    select * from (values
      -- label, order_status, shipping, invoice label, in control?, in PNI?
      ('CLOSED',     'CLOSED',     'SHIPPED',           'INVOICED',                      true,  false),  -- the six-orders shape
      ('CLOSEDPART', 'CLOSED',     'SHIPPED',           'PARTIALLY INVOICED',            true,  false),  -- closed overrides the label
      ('LABELINV',   'AUTHORISED', 'SHIPPED',           'INVOICED',                      true,  false),  -- Cin7 says nothing left to invoice
      ('CREDITED',   'AUTHORISED', 'SHIPPED',           'INVOICED / CREDITED',           true,  false),
      ('READY',      'AUTHORISED', 'SHIPPED',           'NOT INVOICED',                  false, true),   -- ordinary ready-to-invoice
      ('READYPART',  'AUTHORISED', 'SHIPPED',           'PARTIALLY INVOICED',            false, true),
      ('FULFILLED',  'FULFILLED',  'SHIPPED',           'NOT INVOICED',                  false, true),
      ('NOTSHIPPED', 'CLOSED',     'NOT SHIPPED',       'INVOICED',                      false, true),   -- not fully shipped: still ordinary
      ('PARTSHIP',   'CLOSED',     'PARTIALLY SHIPPED', 'INVOICED',                      false, true)
    ) as t(label, ostatus, ship, inv, in_control, in_pni)
  loop
    sid := 'CC-' || c.label;
    insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, order_status, combined_shipping_status, combined_invoice_status, invoice_amount)
      values (org, inst, sid, 'SO-' || sid, current_date - 30, c.ostatus, c.ship, c.inv, 100);
    insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
      values (org, inst, sid, 'pack', 0, 'SKU-X', 10, 'AUTHORISED');
    insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status, invoice_date)
      values (org, inst, sid, 'INV-' || sid, 0, 'SKU-X', 4, 400, 'PAID', current_date - 20);

    select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = sid;
    if r.qualifies_closed_shipped_uninvoiced <> c.in_control then raise exception '% : expected control %, got %', c.label, c.in_control, r.qualifies_closed_shipped_uninvoiced; end if;
    if r.qualifies_packed_not_invoiced <> c.in_pni then raise exception '% : expected Packed-not-Invoiced %, got %', c.label, c.in_pni, r.qualifies_packed_not_invoiced; end if;
    -- An order is in exactly one of the two, never both and never neither (6 uninvoiced units either way).
    if r.qualifies_closed_shipped_uninvoiced = r.qualifies_packed_not_invoiced then raise exception '% : must be in exactly one of control / PNI', c.label; end if;
    if c.in_control and r.closed_uninvoiced_qty <> 6 then raise exception '% : uninvoiced qty should be 10-4=6, got %', c.label, r.closed_uninvoiced_qty; end if;
  end loop;
end $$;

-- Fully invoiced (packed <= invoiced) closed/shipped orders are NOT in the control.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000c1';
  inst uuid := '00000000-0000-0000-0000-0000000000c3';
  r record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, order_status, combined_shipping_status, combined_invoice_status)
    values (org, inst, 'CC-DONE', 'SO-CC-DONE', current_date - 30, 'CLOSED', 'SHIPPED', 'INVOICED');
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
    values (org, inst, 'CC-DONE', 'pack', 0, 'SKU-X', 10, 'AUTHORISED');
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status)
    values (org, inst, 'CC-DONE', 'INV-DONE', 0, 'SKU-X', 10, 1000, 'PAID');
  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'CC-DONE';
  if r.qualifies_closed_shipped_uninvoiced or r.qualifies_packed_not_invoiced then raise exception 'a fully invoiced closed order belongs to neither'; end if;
end $$;

-- Value: priced per SKU at that SKU's own invoiced unit price (ex tax) on the same order; NULL when any uninvoiced SKU is unpriceable.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000c1';
  inst uuid := '00000000-0000-0000-0000-0000000000c3';
  o record;
begin
  -- PRICED: SKU-A packed 10, invoiced 4 for 400 (unit 100) -> 6 uninvoiced x 100 = 600. SKU-B packed 5, invoiced 5 -> nothing uninvoiced.
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, order_status, combined_shipping_status, combined_invoice_status)
    values (org, inst, 'CC-VAL', 'SO-CC-VAL', current_date - 40, 'CLOSED', 'SHIPPED', 'INVOICED');
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
    values (org, inst, 'CC-VAL', 'pack', 0, 'SKU-A', 10, 'AUTHORISED'), (org, inst, 'CC-VAL', 'pack', 1, 'SKU-B', 5, 'AUTHORISED');
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status)
    values (org, inst, 'CC-VAL', 'INV-V1', 0, 'SKU-A', 4, 400, 'PAID'), (org, inst, 'CC-VAL', 'INV-V1', 1, 'SKU-B', 5, 50, 'PAID');
  select * into o from report_scorecard_bottleneck_orders(org, 'closed_shipped_uninvoiced') where order_number = 'SO-CC-VAL';
  if o.relevant_qty <> 6 then raise exception 'CC-VAL qty should be 6, got %', o.relevant_qty; end if;
  if o.invoice_amount <> 600 then raise exception 'CC-VAL value should be 6 x 100 = 600, got %', o.invoice_amount; end if;
  if o.age_days <> 40 then raise exception 'CC-VAL age should be 40 days from the order date, got %', o.age_days; end if;

  -- UNPRICEABLE: SKU-N was packed (3) but never invoiced on this order -> no defensible price -> NULL, not a guess.
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, order_status, combined_shipping_status, combined_invoice_status)
    values (org, inst, 'CC-NOPRICE', 'SO-CC-NOPRICE', current_date - 10, 'CLOSED', 'SHIPPED', 'INVOICED');
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
    values (org, inst, 'CC-NOPRICE', 'pack', 0, 'SKU-N', 3, 'AUTHORISED');
  select * into o from report_scorecard_bottleneck_orders(org, 'closed_shipped_uninvoiced') where order_number = 'SO-CC-NOPRICE';
  if o.relevant_qty <> 3 then raise exception 'CC-NOPRICE qty should be 3, got %', o.relevant_qty; end if;
  if o.invoice_amount is not null then raise exception 'an unpriceable order must have NULL value, got %', o.invoice_amount; end if;
end $$;

-- The dashboard function exposes the control as a sixth row, outside the four KPI queues, with its quantity;
-- the other queues' rows still agree with the separate summary function.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000c1';
  d record;
  s record;
  n integer;
begin
  select count(*) into n from report_scorecard_bottleneck_dashboard(org);
  if n <> 6 then raise exception 'dashboard function must return 6 rows, got %', n; end if;

  select * into d from report_scorecard_bottleneck_dashboard(org) where queue = 'closed_shipped_uninvoiced';
  -- CLOSED, CLOSEDPART, LABELINV, CREDITED (6 units each) + CC-VAL (6) + CC-NOPRICE (3) = 6 orders / 33 units.
  if d.current_count <> 6 or d.closed_uninvoiced_qty <> 33 then raise exception 'control row should be 6 orders / 33 units, got % / %', d.current_count, d.closed_uninvoiced_qty; end if;

  for s in select * from report_scorecard_bottleneck_summary(org) loop
    select * into d from report_scorecard_bottleneck_dashboard(org) where queue = s.queue;
    if d.current_count is distinct from s.current_count or d.oldest_age_days is distinct from s.oldest_age_days
       or d.outside_sla_count is distinct from s.outside_sla_count or d.total_value is distinct from s.total_value then
      raise exception 'dashboard row % differs from summary', s.queue;
    end if;
  end loop;

  -- Packed but Not Invoiced holds exactly the three ordinary ready-to-invoice orders + the two not-fully-shipped ones.
  select current_count into n from report_scorecard_bottleneck_summary(org) where queue = 'packed_not_invoiced';
  if n <> 5 then raise exception 'Packed but Not Invoiced should keep READY, READYPART, FULFILLED, NOTSHIPPED, PARTSHIP (5), got %', n; end if;

  -- Existing drill-down queues are unaffected by the new branch.
  select count(*) into n from report_scorecard_bottleneck_orders(org, 'packed_not_invoiced') where order_number like 'SO-CC-%';
  if n <> 5 then raise exception 'PNI drill-down should list 5, got %', n; end if;
end $$;

do $$ begin raise notice 'ALL 0100 CLOSED / SHIPPED BUT UNINVOICED TESTS PASSED'; end $$;

rollback;
