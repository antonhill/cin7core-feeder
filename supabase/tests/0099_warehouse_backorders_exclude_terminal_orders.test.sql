-- Transactional test for migration 0099 (Backorders Rule A: exclude fully shipped AND
-- fully invoiced orders). BEGIN/ROLLBACK; expect "ALL 0099 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000b1', 'Backorder Rule Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000b1', 'Backorder Rule Test Instance', 'acct-b', 'enc');

do $$
declare opts text[];
begin
  select reloptions into opts from pg_class where relname = 'scorecard_bottleneck_orders_v' and relkind = 'v';
  if opts is null or not ('security_invoker=true' = any(opts)) then
    raise exception 'scorecard_bottleneck_orders_v must stay WITH (security_invoker = true) -- got %', opts;
  end if;
end $$;

do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000b1';
  inst uuid := '00000000-0000-0000-0000-0000000000b3';
  c record;
  sid text;
  r record;
  n integer;
begin
  for c in
    select * from (values
      -- label, shipping label, invoice label, expect in Backorders queue
      ('TERMINAL',   'SHIPPED',           'INVOICED',                      false),  -- SO-11579 shape
      ('CREDITED',   'SHIPPED',           'INVOICED / CREDITED',           false),
      ('PARTINV',    'SHIPPED',           'PARTIALLY INVOICED',            true),
      ('PARTINVCR',  'SHIPPED',           'PARTIALLY INVOICED / CREDITED', true),
      ('NOTINV',     'SHIPPED',           'NOT INVOICED',                  true),
      ('PARTSHIP',   'PARTIALLY SHIPPED', 'INVOICED',                      true),
      ('SHIPPING',   'SHIPPING',          'INVOICED',                      true),
      ('NOTSHIP',    'NOT SHIPPED',       'INVOICED',                      true)
    ) as t(label, ship, inv, expect_in)
  loop
    sid := 'BO-' || c.label;
    insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, combined_shipping_status, combined_invoice_status)
      values (org, inst, sid, 'SO-' || sid, current_date - 20, c.ship, c.inv);
    insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, quantity, backorder_quantity)
      values (org, inst, sid, 0, 'SKU-1', 37, 34);

    select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = sid;
    if r.qualifies_backorder_awaiting_stock <> c.expect_in then
      raise exception '% (ship %, invoice %): expected in-queue %, got %', c.label, c.ship, c.inv, c.expect_in, r.qualifies_backorder_awaiting_stock;
    end if;
    -- The raw backorder quantity is untouched; only the qualifier changes.
    if r.backorder_qty <> 34 then raise exception '% : backorder_qty column must stay the raw 34, got %', c.label, r.backorder_qty; end if;
  end loop;

  -- Counts and the drill-down agree with the qualifier: 6 of the 8 stay.
  select count(*) into n from report_scorecard_bottleneck_orders(org, 'backorders_awaiting_stock') where order_number like 'SO-BO-%';
  if n <> 6 then raise exception 'drill-down should list 6 backorder orders, got %', n; end if;
  select current_count into n from report_scorecard_bottleneck_summary(org) where queue = 'backorders_awaiting_stock';
  if n <> 6 then raise exception 'summary should count 6 backorder orders, got %', n; end if;
  select current_count into n from report_scorecard_bottleneck_dashboard(org) where queue = 'backorders_awaiting_stock';
  if n <> 6 then raise exception 'dashboard function should count 6 backorder orders, got %', n; end if;
  -- The terminal order does not appear; a partially shipped one does.
  select count(*) into n from report_scorecard_bottleneck_orders(org, 'backorders_awaiting_stock') where order_number in ('SO-BO-TERMINAL', 'SO-BO-CREDITED');
  if n <> 0 then raise exception 'terminal orders must not appear in the Backorders drill-down'; end if;
end $$;

do $$ begin raise notice 'ALL 0099 BACKORDERS RULE A TESTS PASSED'; end $$;

rollback;
