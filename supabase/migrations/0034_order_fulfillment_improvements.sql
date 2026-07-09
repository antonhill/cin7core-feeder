-- Order Fulfillment Dashboard improvements: order age ("stuck" orders),
-- audit trail of where a line was actually picked from, and forward
-- guidance on where to pick a still-outstanding line from (cross-
-- referencing Stock Health's already-synced product_availability, rather
-- than sale_pick_pack_lines — that table only ever records completed
-- pick events, so it has nothing to say about a line that hasn't been
-- picked yet at all).

alter table sales add column if not exists order_date date;
-- `bin` stays permanently null — confirmed live 2026-07-09 that Sale
-- Fulfilment Pick/Pack lines carry Location/LocationID/BatchSN but no Bin
-- field at all (that's a Product Availability concept, wrongly assumed to
-- exist here too before checking). Left as a column rather than dropped —
-- harmless, and cheap to wire up later if Cin7 ever adds it.
alter table sale_pick_pack_lines
  add column if not exists location text,
  add column if not exists bin text,
  add column if not exists batch_sn text;

-- Postgres won't let create-or-replace change a set-returning function's
-- column list — both need dropping first since this adds new output columns.
drop function if exists report_order_fulfillment(uuid, uuid[]);
drop function if exists report_order_fulfillment_lines(uuid, uuid[]);

create function report_order_fulfillment_lines(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  cin7_sale_id text,
  product_sku text,
  product_name text,
  ordered_qty numeric,
  backorder_qty numeric,
  picked_qty numeric,
  packed_qty numeric,
  pickable_qty numeric,
  picked_from_locations text,
  suggested_pick_location text,
  suggested_pick_location_on_hand numeric
) language sql stable set search_path = public as $$
  with picked as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pick'
    group by cin7_sale_id, product_sku
  ),
  packed as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pack'
    group by cin7_sale_id, product_sku
  ),
  picked_locations as (
    select cin7_sale_id, product_sku, string_agg(distinct location, ', ' order by location) as locations
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pick'
      and location is not null
    group by cin7_sale_id, product_sku
  ),
  -- One suggested location per (instance, SKU) — whichever real stock
  -- location currently holds the most on-hand, so a picker isn't sent to
  -- an empty bin. instance_id matters here (unlike the sale-level tables)
  -- since product_availability is a live snapshot per instance, not scoped
  -- to one sale.
  best_location as (
    select distinct on (instance_id, product_sku)
      instance_id, product_sku, location, on_hand
    from product_availability
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and on_hand > 0
    order by instance_id, product_sku, on_hand desc
  )
  select
    ol.cin7_sale_id,
    ol.product_sku,
    ol.product_name,
    coalesce(ol.quantity, 0) as ordered_qty,
    coalesce(ol.backorder_quantity, 0) as backorder_qty,
    coalesce(pk.qty, 0) as picked_qty,
    coalesce(pa.qty, 0) as packed_qty,
    greatest(coalesce(ol.quantity, 0) - coalesce(ol.backorder_quantity, 0) - coalesce(pk.qty, 0), 0) as pickable_qty,
    pl.locations as picked_from_locations,
    bl.location as suggested_pick_location,
    bl.on_hand as suggested_pick_location_on_hand
  from sale_order_lines ol
  left join picked pk on pk.cin7_sale_id = ol.cin7_sale_id and pk.product_sku = ol.product_sku
  left join packed pa on pa.cin7_sale_id = ol.cin7_sale_id and pa.product_sku = ol.product_sku
  left join picked_locations pl on pl.cin7_sale_id = ol.cin7_sale_id and pl.product_sku = ol.product_sku
  left join best_location bl on bl.instance_id = ol.instance_id and bl.product_sku = ol.product_sku
  where ol.org_id = p_org_id
    and (p_instance_ids is null or ol.instance_id = any (p_instance_ids))
  order by ol.cin7_sale_id, ol.line_number;
$$;

create function report_order_fulfillment(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  cin7_sale_id text,
  instance_id uuid,
  order_number text,
  customer_name text,
  order_date date,
  days_open integer,
  ship_by date,
  is_overdue boolean,
  order_status text,
  combined_picking_status text,
  combined_packing_status text,
  combined_shipping_status text,
  combined_invoice_status text,
  combined_payment_status text,
  paid_amount numeric,
  invoice_amount numeric,
  total_ordered_qty numeric,
  total_backorder_qty numeric,
  total_pickable_qty numeric,
  total_picked_qty numeric,
  is_pick_today boolean,
  is_ship_today boolean
) language sql stable set search_path = public as $$
  with totals as (
    select
      cin7_sale_id,
      sum(ordered_qty) as total_ordered_qty,
      sum(backorder_qty) as total_backorder_qty,
      sum(pickable_qty) as total_pickable_qty,
      sum(picked_qty) as total_picked_qty
    from report_order_fulfillment_lines(p_org_id, p_instance_ids)
    group by cin7_sale_id
  )
  select
    s.cin7_sale_id,
    s.instance_id,
    s.order_number,
    s.customer_name,
    s.order_date,
    case when s.order_date is not null then (current_date - s.order_date) end as days_open,
    s.ship_by,
    (s.ship_by is not null and s.ship_by < current_date) as is_overdue,
    s.order_status,
    s.combined_picking_status,
    s.combined_packing_status,
    s.combined_shipping_status,
    s.combined_invoice_status,
    s.combined_payment_status,
    s.paid_amount,
    s.invoice_amount,
    coalesce(t.total_ordered_qty, 0) as total_ordered_qty,
    coalesce(t.total_backorder_qty, 0) as total_backorder_qty,
    coalesce(t.total_pickable_qty, 0) as total_pickable_qty,
    coalesce(t.total_picked_qty, 0) as total_picked_qty,
    coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false) and coalesce(t.total_pickable_qty, 0) > 0 as is_pick_today,
    coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false) as is_ship_today
  from sales s
  left join totals t on t.cin7_sale_id = s.cin7_sale_id
  where s.org_id = p_org_id
    and (p_instance_ids is null or s.instance_id = any (p_instance_ids))
  order by (s.ship_by is null) asc, s.ship_by asc;
$$;
