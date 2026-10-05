-- Transactional test for migration 0098 (queue view scan consolidation, Ready-to-Pick
-- duplicate-SKU fix, single-call dashboard function). BEGIN/ROLLBACK: safe against any
-- DB with 0098 applied, leaves no rows. Expect "ALL 0098 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-0000000000a1', 'Dashboard Test Org');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted)
  values ('00000000-0000-0000-0000-0000000000a3', '00000000-0000-0000-0000-0000000000a1', 'Dashboard Test Instance', 'acct-a', 'enc');

-- The view keeps security_invoker after being replaced.
do $$
declare opts text[];
begin
  select reloptions into opts from pg_class where relname = 'scorecard_bottleneck_orders_v' and relkind = 'v';
  if opts is null or not ('security_invoker=true' = any(opts)) then
    raise exception 'scorecard_bottleneck_orders_v must stay WITH (security_invoker = true) -- got %', opts;
  end if;
end $$;

-- Ready to Pick: picked quantity is subtracted ONCE per SKU, not once per duplicate order line
-- (SO-17607 shape: two lines of one SKU, 230 ordered of which 29 backordered, 189 picked -> 12 left).
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000a1';
  inst uuid := '00000000-0000-0000-0000-0000000000a3';
  r record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, combined_picking_status)
    values (org, inst, 'DUP-1', 'SO-DUP-1', current_date - 3, 'PARTIALLY PICKED');
  insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, quantity, backorder_quantity)
    values (org, inst, 'DUP-1', 0, 'SKU-D', 100, 29), (org, inst, 'DUP-1', 1, 'SKU-D', 130, 0), (org, inst, 'DUP-1', 2, 'SKU-E', 10, 0);
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
    values (org, inst, 'DUP-1', 'pick', 0, 'SKU-D', 189, 'AUTHORISED'), (org, inst, 'DUP-1', 'pick', 1, 'SKU-E', 10, 'AUTHORISED');
  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'DUP-1';
  if r.pickable_qty <> 12 then raise exception 'duplicate-SKU pickable should be 12 (230-29-189), got %', r.pickable_qty; end if;
  if not r.qualifies_ready_to_pick then raise exception 'DUP-1 must qualify for Ready to Pick'; end if;
  if r.backorder_qty <> 29 then raise exception 'backorder_qty must still be the sum of line backorders (29), got %', r.backorder_qty; end if;
  if not r.qualifies_backorder_awaiting_stock then raise exception 'DUP-1 must still qualify for Backorders'; end if;
end $$;

-- A SKU picked beyond its order quantity clamps at 0 PER SKU and never reduces another SKU's remaining quantity.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000a1';
  inst uuid := '00000000-0000-0000-0000-0000000000a3';
  r record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date, combined_picking_status)
    values (org, inst, 'CLAMP-1', 'SO-CLAMP-1', current_date - 3, 'PARTIALLY PICKED');
  insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, quantity, backorder_quantity)
    values (org, inst, 'CLAMP-1', 0, 'SKU-A', 5, 0), (org, inst, 'CLAMP-1', 1, 'SKU-B', 7, 0);
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
    values (org, inst, 'CLAMP-1', 'pick', 0, 'SKU-A', 9, 'AUTHORISED');
  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'CLAMP-1';
  if r.pickable_qty <> 7 then raise exception 'over-picked SKU-A must clamp to 0 and leave SKU-B at 7, got %', r.pickable_qty; end if;
end $$;

-- Legacy pack lines with NO fulfilment id (never re-synced): authorised-pack quantity is still summed per LINE status.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000a1';
  inst uuid := '00000000-0000-0000-0000-0000000000a3';
  r record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date) values (org, inst, 'LEG-1', 'SO-LEG-1', current_date - 4);
  insert into sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, stage, line_number, product_sku, quantity, status)
    values (org, inst, 'LEG-1', 'pack', 0, 'A', 5, 'AUTHORISED'), (org, inst, 'LEG-1', 'pack', 1, 'B', 3, 'NOT AVAILABLE'), (org, inst, 'LEG-1', 'pack', 2, 'C', 2, 'AUTHORISED');
  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'LEG-1';
  if r.packed_authorised_qty <> 7 then raise exception 'legacy no-fulfilment-id pack lines: AUTHORISED qty should be 7, got %', r.packed_authorised_qty; end if;
  if not r.qualifies_packed_not_invoiced then raise exception 'LEG-1 should qualify for Packed but Not Invoiced (7 packed, 0 invoiced)'; end if;
end $$;

-- Invoiced quantity and latest date come from the per-invoice aggregate, over AUTHORISED/PAID only.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000a1';
  inst uuid := '00000000-0000-0000-0000-0000000000a3';
  r record;
begin
  insert into sales (org_id, instance_id, cin7_sale_id, order_number, order_date) values (org, inst, 'INV-1', 'SO-INV-X', current_date - 9);
  insert into sale_lines (org_id, instance_id, cin7_sale_id, invoice_number, line_number, product_sku, quantity, total, invoice_status, invoice_date)
    values (org, inst, 'INV-1', 'I1', 0, 'A', 4, 40, 'PAID', current_date - 8), (org, inst, 'INV-1', 'I1', 1, 'B', 1, 10, 'PAID', current_date - 8),
           (org, inst, 'INV-1', 'I2', 0, 'A', 6, 60, 'AUTHORISED', current_date - 2), (org, inst, 'INV-1', 'I3', 0, 'A', 99, 990, 'DRAFT', current_date - 1);
  select * into r from scorecard_bottleneck_orders_v where org_id = org and cin7_sale_id = 'INV-1';
  if r.invoiced_qty <> 11 then raise exception 'invoiced_qty should be 4+1+6=11 (DRAFT excluded), got %', r.invoiced_qty; end if;
  if r.latest_invoice_date <> current_date - 2 then raise exception 'latest_invoice_date should be 2 days ago, got %', r.latest_invoice_date; end if;
end $$;

-- The single-call dashboard function returns the four KPI queues + shipment_state_unclear, and agrees
-- row-for-row with the separate summary / unclear-summary functions on the same data.
do $$
declare
  org uuid := '00000000-0000-0000-0000-0000000000a1';
  d record;
  s record;
  u record;
  n integer;
begin
  select count(*) into n from report_scorecard_bottleneck_dashboard(org);
  if n <> 5 then raise exception 'dashboard function must return exactly 5 rows, got %', n; end if;

  for s in select * from report_scorecard_bottleneck_summary(org) loop
    select * into d from report_scorecard_bottleneck_dashboard(org) where queue = s.queue;
    if d.current_count is distinct from s.current_count
       or d.oldest_age_days is distinct from s.oldest_age_days
       or d.outside_sla_count is distinct from s.outside_sla_count
       or d.total_value is distinct from s.total_value then
      raise exception 'dashboard row % differs from summary: % vs %', s.queue, d, s;
    end if;
  end loop;

  select * into u from report_scorecard_shipment_unclear_summary(org);
  select * into d from report_scorecard_bottleneck_dashboard(org) where queue = 'shipment_state_unclear';
  if d.current_count is distinct from u.current_count or d.oldest_age_days is distinct from u.oldest_age_days or d.unclear_qty is distinct from u.unclear_qty then
    raise exception 'dashboard unclear row differs from the unclear summary: % vs %', d, u;
  end if;

  -- An org with no sales: zeros / nulls, never an error.
  select count(*) into n from report_scorecard_bottleneck_dashboard('00000000-0000-0000-0000-0000000000a9'::uuid);
  if n <> 5 then raise exception 'empty org must still return 5 rows, got %', n; end if;
  select count(*) into n from report_scorecard_bottleneck_dashboard('00000000-0000-0000-0000-0000000000a9'::uuid) where current_count <> 0;
  if n <> 0 then raise exception 'empty org must have zero counts'; end if;
end $$;

-- search_path is pinned on the new function.
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'report_scorecard_bottleneck_dashboard'
                   and exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')) then
    raise exception 'report_scorecard_bottleneck_dashboard must pin search_path';
  end if;
end $$;

do $$ begin raise notice 'ALL 0098 WAREHOUSE QUEUE VIEW CONSOLIDATION TESTS PASSED'; end $$;

rollback;
