-- Order Fulfillment Dashboard, Phase 2 — the actual report. Two functions:
-- report_order_fulfillment_lines gives the per-SKU detail (ordered/
-- backordered/picked/packed/still-pickable quantity per order line);
-- report_order_fulfillment aggregates that up to one row per order plus
-- the Combined status fields Phase 1 already synced, and exposes two plain
-- booleans (is_pick_today/is_ship_today) rather than a fuzzy bucket label —
-- confirmed live 2026-07-09 that pick/pack/ship/invoice don't gate each
-- other in a fixed sequence on this account, so a single derived "stage"
-- enum would misrepresent real combinations (e.g. invoiced before packed).
--
-- "Pick/Ship Today" are queues, not a strict date filter: per Anton's
-- explicit call, overdue orders stay in the queue (flagged, sorted first)
-- and undated orders stay in the queue too (sorted last) rather than being
-- excluded — nothing that still needs action drops out of sight just
-- because it's overdue or has no ship-by date set.
create or replace function report_order_fulfillment_lines(
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
  pickable_qty numeric
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
  )
  select
    ol.cin7_sale_id,
    ol.product_sku,
    ol.product_name,
    coalesce(ol.quantity, 0) as ordered_qty,
    coalesce(ol.backorder_quantity, 0) as backorder_qty,
    coalesce(pk.qty, 0) as picked_qty,
    coalesce(pa.qty, 0) as packed_qty,
    greatest(coalesce(ol.quantity, 0) - coalesce(ol.backorder_quantity, 0) - coalesce(pk.qty, 0), 0) as pickable_qty
  from sale_order_lines ol
  left join picked pk on pk.cin7_sale_id = ol.cin7_sale_id and pk.product_sku = ol.product_sku
  left join packed pa on pa.cin7_sale_id = ol.cin7_sale_id and pa.product_sku = ol.product_sku
  where ol.org_id = p_org_id
    and (p_instance_ids is null or ol.instance_id = any (p_instance_ids))
  order by ol.cin7_sale_id, ol.line_number;
$$;

create or replace function report_order_fulfillment(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  cin7_sale_id text,
  order_number text,
  customer_name text,
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
    s.order_number,
    s.customer_name,
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
