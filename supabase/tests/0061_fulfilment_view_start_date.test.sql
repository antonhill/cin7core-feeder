-- Transactional test for migration 0061's date-floor logic in
-- report_order_fulfillment. BEGIN/ROLLBACK: safe against any DB with 0061
-- applied, leaves no rows. Expect it to print "ALL 0061 ... PASSED".

begin;

insert into organizations (id, name) values ('00000000-0000-0000-0000-000000000701', 'Fulfilment Floor Test Org');

-- Two instances: one with a floor set, one without — proves the setting is
-- genuinely per-instance, not per-org.
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted, fulfilment_view_start_date)
  values ('00000000-0000-0000-0000-000000000702', '00000000-0000-0000-0000-000000000701', 'Floored Instance', 'acct-f', 'enc-f', '2026-01-01');
insert into cin7_instances (id, org_id, name, account_id, application_key_encrypted, fulfilment_view_start_date)
  values ('00000000-0000-0000-0000-000000000703', '00000000-0000-0000-0000-000000000701', 'Unfloored Instance', 'acct-u', 'enc-u', null);

-- Every sale below qualifies for both pick and ship on its own merits
-- (picking status not done + pickable qty > 0; shipping status not done) —
-- the floor is the only variable under test.
insert into sales (org_id, instance_id, cin7_sale_id, order_number, customer_name, ship_by, order_date, combined_picking_status, combined_shipping_status)
values
  -- A: old ship_by, floored instance -> hidden from both queues.
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-a', 'SO-A', 'Cust', '2025-06-01', '2025-05-01', 'NOT PICKED', 'NOT SHIPPED'),
  -- B: recent ship_by, floored instance -> visible.
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-b', 'SO-B', 'Cust', '2026-03-01', '2025-05-01', 'NOT PICKED', 'NOT SHIPPED'),
  -- C: no ship_by, old order_date, floored instance -> hidden via fallback.
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-c', 'SO-C', 'Cust', null, '2025-01-01', 'NOT PICKED', 'NOT SHIPPED'),
  -- D: no ship_by, no order_date at all, floored instance -> floor does NOT apply (nothing to judge staleness by).
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-d', 'SO-D', 'Cust', null, null, 'NOT PICKED', 'NOT SHIPPED'),
  -- E: old ship_by, UNFLOORED instance -> visible (no floor configured at all).
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000703', 'sale-e', 'SO-E', 'Cust', '2025-06-01', '2025-05-01', 'NOT PICKED', 'NOT SHIPPED');

insert into sale_order_lines (org_id, instance_id, cin7_sale_id, line_number, product_sku, product_name, quantity, backorder_quantity)
values
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-a', 0, 'SKU-1', 'Widget', 5, 0),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-b', 0, 'SKU-1', 'Widget', 5, 0),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-c', 0, 'SKU-1', 'Widget', 5, 0),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000702', 'sale-d', 0, 'SKU-1', 'Widget', 5, 0),
  ('00000000-0000-0000-0000-000000000701', '00000000-0000-0000-0000-000000000703', 'sale-e', 0, 'SKU-1', 'Widget', 5, 0);

do $$
declare
  org uuid := '00000000-0000-0000-0000-000000000701';
  r record;
  by_id jsonb := '{}'::jsonb;
begin
  for r in select * from report_order_fulfillment(org, null) loop
    by_id := by_id || jsonb_build_object(
      r.cin7_sale_id,
      jsonb_build_object(
        'is_pick_today', r.is_pick_today,
        'is_ship_today', r.is_ship_today,
        'pick_hidden', r.pick_today_hidden_by_floor,
        'ship_hidden', r.ship_today_hidden_by_floor
      )
    );
  end loop;

  -- Every sale must still come back at all — "All Orders" ignores the floor.
  if (select count(*) from jsonb_object_keys(by_id)) is distinct from 5 then
    raise exception 'expected all 5 sales to still be returned (All Orders ignores the floor), got keys: %', by_id;
  end if;

  -- A: old ship_by, floored -> hidden from both, and flagged as hidden-by-floor.
  if (by_id->'sale-a'->>'is_pick_today')::boolean is not false
    or (by_id->'sale-a'->>'is_ship_today')::boolean is not false
    or (by_id->'sale-a'->>'pick_hidden')::boolean is not true
    or (by_id->'sale-a'->>'ship_hidden')::boolean is not true
  then raise exception 'sale-a (old ship_by, floored instance) should be hidden by the floor and flagged, got %', by_id->'sale-a'; end if;

  -- B: recent ship_by, floored -> visible, not flagged.
  if (by_id->'sale-b'->>'is_pick_today')::boolean is not true
    or (by_id->'sale-b'->>'is_ship_today')::boolean is not true
    or (by_id->'sale-b'->>'pick_hidden')::boolean is not false
    or (by_id->'sale-b'->>'ship_hidden')::boolean is not false
  then raise exception 'sale-b (recent ship_by, floored instance) should be visible and not flagged, got %', by_id->'sale-b'; end if;

  -- C: no ship_by, old order_date, floored -> hidden via the order_date fallback.
  if (by_id->'sale-c'->>'is_pick_today')::boolean is not false
    or (by_id->'sale-c'->>'pick_hidden')::boolean is not true
  then raise exception 'sale-c (no ship_by, old order_date, floored instance) should be hidden via the order_date fallback, got %', by_id->'sale-c'; end if;

  -- D: neither date at all, floored -> floor does NOT apply; visible, not flagged.
  if (by_id->'sale-d'->>'is_pick_today')::boolean is not true
    or (by_id->'sale-d'->>'pick_hidden')::boolean is not false
  then raise exception 'sale-d (no dates at all, floored instance) should NOT be hidden (nothing to judge staleness by), got %', by_id->'sale-d'; end if;

  -- E: old ship_by, UNFLOORED instance -> visible, not flagged (no floor set at all).
  if (by_id->'sale-e'->>'is_pick_today')::boolean is not true
    or (by_id->'sale-e'->>'pick_hidden')::boolean is not false
  then raise exception 'sale-e (old ship_by, unfloored instance) should be visible — no floor configured, got %', by_id->'sale-e'; end if;
end $$;

do $$ begin raise notice 'ALL 0061 FULFILMENT-VIEW-START-DATE ASSERTIONS PASSED'; end $$;

rollback;
