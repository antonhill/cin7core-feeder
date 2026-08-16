-- Hotfix: report_order_fulfillment_lines scanned sale_pick_pack_lines FOUR
-- separate times (once each for the picked/packed/packed_authorised/
-- picked_locations CTEs). For LBL's org (28k+ sale_order_lines, 48k+
-- sale_pick_pack_lines rows) this pushed report_order_fulfillment past its
-- statement timeout in production — Shipping Calendar failing outright with
-- "canceling statement due to statement timeout" (reported by Anton,
-- 2026-08-16).
--
-- Fix: consolidate the four CTEs into one pass with FILTER-clause
-- conditional aggregation. Confirmed live via EXPLAIN ANALYZE against the
-- affected org: report_order_fulfillment's total execution time dropped
-- from ~6.7s to ~0.6-1.4s, with output verified byte-for-byte identical
-- (row counts, every aggregate sum, and the picked-location strings all
-- matched the old four-CTE version exactly before this shipped). All three
-- existing transactional test suites (0061/0062/0063) re-run clean against
-- this rewrite.
--
-- Pure function-body change, same signature/output columns as before, so
-- CREATE OR REPLACE is correct here — no drop-and-recreate needed (that's
-- only required when the RETURNS TABLE shape itself changes).
create or replace function report_order_fulfillment_lines(p_org_id uuid, p_instance_ids uuid[] default null)
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
  suggested_pick_location_on_hand numeric,
  backorder_po_number text,
  backorder_eta date,
  backorder_po_outstanding_qty numeric,
  packed_qty_authorised numeric,
  invoiced_qty numeric,
  ready_to_invoice_qty numeric,
  ready_for_box_label_qty numeric
) language sql stable set search_path = public as $$
  with pick_pack as (
    select
      cin7_sale_id,
      product_sku,
      sum(quantity) filter (where stage = 'pick') as picked_qty,
      sum(quantity) filter (where stage = 'pack') as packed_qty,
      sum(quantity) filter (where stage = 'pack' and status = 'AUTHORISED') as packed_authorised_qty,
      string_agg(distinct location, ', ' order by location) filter (where stage = 'pick' and location is not null) as picked_locations
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
    group by cin7_sale_id, product_sku
  ),
  invoiced as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and invoice_status in ('AUTHORISED', 'PAID')
    group by cin7_sale_id, product_sku
  ),
  best_location as (
    select distinct on (instance_id, product_sku)
      instance_id, product_sku, location, on_hand
    from product_availability
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and on_hand > 0
    order by instance_id, product_sku, on_hand desc
  ),
  purchase_ordered as (
    select org_id, instance_id, cin7_purchase_id, product_sku, sum(quantity) as ordered_qty
    from purchase_order_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
    group by org_id, instance_id, cin7_purchase_id, product_sku
  ),
  purchase_received as (
    select org_id, instance_id, cin7_purchase_id, product_sku, sum(quantity) as received_qty
    from purchase_receipt_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
    group by org_id, instance_id, cin7_purchase_id, product_sku
  ),
  purchase_outstanding as (
    select po.instance_id, po.product_sku, p.order_number, p.required_by,
      coalesce(po.ordered_qty, 0) - coalesce(pr.received_qty, 0) as outstanding_qty
    from purchase_ordered po
    join purchases p
      on p.org_id = po.org_id and p.instance_id = po.instance_id and p.cin7_purchase_id = po.cin7_purchase_id
    left join purchase_received pr
      on pr.org_id = po.org_id and pr.instance_id = po.instance_id and pr.cin7_purchase_id = po.cin7_purchase_id
      and pr.product_sku = po.product_sku
    where po.org_id = p_org_id
      and (p_instance_ids is null or po.instance_id = any (p_instance_ids))
      and p.is_drop_ship = false
      and p.combined_receiving_status in ('NOT RECEIVED', 'PARTIALLY RECEIVED')
  ),
  backorder_eta as (
    select distinct on (instance_id, product_sku)
      instance_id, product_sku, order_number, required_by, outstanding_qty
    from purchase_outstanding
    where outstanding_qty > 0
    order by instance_id, product_sku, (required_by is null) asc, required_by asc
  )
  select
    ol.cin7_sale_id,
    ol.product_sku,
    ol.product_name,
    coalesce(ol.quantity, 0) as ordered_qty,
    coalesce(ol.backorder_quantity, 0) as backorder_qty,
    coalesce(pp.picked_qty, 0) as picked_qty,
    coalesce(pp.packed_qty, 0) as packed_qty,
    greatest(coalesce(ol.quantity, 0) - coalesce(ol.backorder_quantity, 0) - coalesce(pp.picked_qty, 0), 0) as pickable_qty,
    pp.picked_locations as picked_from_locations,
    bl.location as suggested_pick_location,
    bl.on_hand as suggested_pick_location_on_hand,
    be.order_number as backorder_po_number,
    be.required_by as backorder_eta,
    be.outstanding_qty as backorder_po_outstanding_qty,
    coalesce(pp.packed_authorised_qty, 0) as packed_qty_authorised,
    coalesce(inv.qty, 0) as invoiced_qty,
    greatest(coalesce(pp.packed_authorised_qty, 0) - coalesce(inv.qty, 0), 0) as ready_to_invoice_qty,
    case when coalesce(pp.packed_authorised_qty, 0) > 0 and coalesce(inv.qty, 0) >= coalesce(pp.packed_authorised_qty, 0)
      then coalesce(pp.packed_authorised_qty, 0) else 0 end as ready_for_box_label_qty
  from sale_order_lines ol
  left join pick_pack pp on pp.cin7_sale_id = ol.cin7_sale_id and pp.product_sku = ol.product_sku
  left join invoiced inv on inv.cin7_sale_id = ol.cin7_sale_id and inv.product_sku = ol.product_sku
  left join best_location bl on bl.instance_id = ol.instance_id and bl.product_sku = ol.product_sku
  left join backorder_eta be on be.instance_id = ol.instance_id and be.product_sku = ol.product_sku
  where ol.org_id = p_org_id
    and (p_instance_ids is null or ol.instance_id = any (p_instance_ids))
  order by ol.cin7_sale_id, ol.line_number;
$$;
