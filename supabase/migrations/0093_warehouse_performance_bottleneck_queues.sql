-- Warehouse Performance Scorecard — the four bottleneck queues.
--
-- Deliberately NOT added to report_order_fulfillment_fs / _queue_page_json /
-- _tab_counts (migration 0091). Those functions are already measured live
-- at 94-96% of the 8-second PostgREST statement timeout in production —
-- widening them for a second, unrelated feature is an avoidable risk to an
-- already fragile, sixteen-times-rewritten function family (see Reporting
-- Architecture / Material Incidents and Corrections in Spark Knowledge).
-- This migration reuses the same underlying tables and business
-- definitions where they overlap (Ready to Pick, Packed but Not Invoiced),
-- but as new, independent SQL — the scorecard module must not be able to
-- destabilise Order Fulfilment reporting, and vice versa.
--
-- A base view carries the shared per-order aggregation once, so the
-- dashboard's summary counts and its drill-down orders can never disagree
-- with each other about which orders qualify — the same "one definition,
-- many callers" discipline Order Fulfilment already uses, and the same
-- lesson [[Order Fulfilment and Invoicing]] draws from its own history of
-- queues disagreeing.
--
-- KNOWN EVIDENCE LIMITATION, stated here rather than silently glossed over:
-- no "packed at" or "invoiced at" event timestamp is synced anywhere in
-- this schema — only order_date (sales) and per-invoice-line invoice_date
-- (sale_lines) exist. So:
--   - Ready to Pick and Backorders Awaiting Stock age from order_date,
--     which genuinely describes how long the order itself has existed.
--   - Invoiced but Not Shipped ages from the latest real invoice_date on
--     the sale, which genuinely describes how long ago it was invoiced.
--   - Packed but Not Invoiced has NO genuine "time since packed" evidence
--     available — sale_pick_pack_lines carries no timestamp at all. It
--     falls back to order_date as a proxy, which measures order age, not
--     packing age, and is flagged in the UI and in scorecard-queues.ts
--     rather than presented as if it answers the brief's actual question.
--     A real fix needs Cin7 to expose (and this product to sync) a
--     fulfilment-level pack timestamp — a Phase 2 candidate, not built here.

create or replace view scorecard_bottleneck_orders_v as
with pickable as (
  select ol.org_id, ol.instance_id, ol.cin7_sale_id,
    sum(greatest(coalesce(ol.quantity, 0) - coalesce(ol.backorder_quantity, 0) - coalesce(pk.qty, 0), 0)) as pickable_qty
  from sale_order_lines ol
  left join (
    select org_id, instance_id, cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_pick_pack_lines
    where stage = 'pick'
    group by org_id, instance_id, cin7_sale_id, product_sku
  ) pk on pk.org_id = ol.org_id and pk.instance_id = ol.instance_id and pk.cin7_sale_id = ol.cin7_sale_id and pk.product_sku = ol.product_sku
  group by ol.org_id, ol.instance_id, ol.cin7_sale_id
),
packed_authorised as (
  select org_id, instance_id, cin7_sale_id, sum(quantity) as qty
  from sale_pick_pack_lines
  where stage = 'pack' and status = 'AUTHORISED'
  group by org_id, instance_id, cin7_sale_id
),
invoiced as (
  select org_id, instance_id, cin7_sale_id,
    sum(quantity) as qty,
    max(invoice_date) as latest_invoice_date
  from sale_lines
  where invoice_status in ('AUTHORISED', 'PAID')
  group by org_id, instance_id, cin7_sale_id
),
backorders as (
  select org_id, instance_id, cin7_sale_id, sum(coalesce(backorder_quantity, 0)) as qty
  from sale_order_lines
  group by org_id, instance_id, cin7_sale_id
),
-- Same shape as 0062's backorder_eta CTE (report_order_fulfillment_lines),
-- reproduced narrowly rather than shared, since that function is part of
-- the fragile family this migration deliberately avoids touching. Only
-- "does an open PO cover this SKU at this instance" is needed here, not
-- the ETA/outstanding-qty detail Order Fulfilment additionally surfaces.
open_po_skus as (
  select distinct po.instance_id, po.product_sku
  from purchase_order_lines po
  join purchases p
    on p.org_id = po.org_id and p.instance_id = po.instance_id and p.cin7_purchase_id = po.cin7_purchase_id
  where p.is_drop_ship = false
    and p.combined_receiving_status in ('NOT RECEIVED', 'PARTIALLY RECEIVED')
),
backorder_po as (
  select bl.org_id, bl.instance_id, bl.cin7_sale_id,
    bool_or(ops.product_sku is not null) as has_open_po
  from sale_order_lines bl
  left join open_po_skus ops on ops.instance_id = bl.instance_id and ops.product_sku = bl.product_sku
  where coalesce(bl.backorder_quantity, 0) > 0
  group by bl.org_id, bl.instance_id, bl.cin7_sale_id
)
select
  s.org_id,
  s.instance_id,
  s.cin7_sale_id,
  s.order_number,
  s.customer_name,
  s.order_date,
  s.ship_by,
  s.combined_picking_status,
  s.combined_shipping_status,
  s.combined_invoice_status,
  s.invoice_amount,
  coalesce(pick.pickable_qty, 0) as pickable_qty,
  coalesce(pa.qty, 0) as packed_authorised_qty,
  coalesce(inv.qty, 0) as invoiced_qty,
  inv.latest_invoice_date,
  coalesce(bo.qty, 0) as backorder_qty,
  coalesce(bp.has_open_po, false) as has_open_po,
  -- Same qualification RULES as report_order_fulfillment_fs where they
  -- overlap (Ready to Pick / Packed-not-Invoiced), reproduced rather than
  -- called, per this migration's header. Deliberately no floor-date
  -- suppression here — the scorecard's own bottleneck cards are meant to
  -- show every currently-qualifying order, not the "act on this today"
  -- subset Order Fulfilment's own queues apply a floor to.
  (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
    and coalesce(pick.pickable_qty, 0) > 0) as qualifies_ready_to_pick,
  (greatest(coalesce(pa.qty, 0) - coalesce(inv.qty, 0), 0) > 0) as qualifies_packed_not_invoiced,
  -- "Invoiced" here means genuinely has invoiced quantity (matches
  -- report_order_fulfillment_fs's own invoice_coverage_status test: some
  -- invoiced_qty > 0), whether partial or full — the brief's target
  -- ("invoiced orders waiting for dispatch") does not distinguish the two.
  (coalesce(inv.qty, 0) > 0
    and coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false)) as qualifies_invoiced_not_shipped,
  (coalesce(bo.qty, 0) > 0) as qualifies_backorder_awaiting_stock
from sales s
left join pickable pick on pick.org_id = s.org_id and pick.instance_id = s.instance_id and pick.cin7_sale_id = s.cin7_sale_id
left join packed_authorised pa on pa.org_id = s.org_id and pa.instance_id = s.instance_id and pa.cin7_sale_id = s.cin7_sale_id
left join invoiced inv on inv.org_id = s.org_id and inv.instance_id = s.instance_id and inv.cin7_sale_id = s.cin7_sale_id
left join backorders bo on bo.org_id = s.org_id and bo.instance_id = s.instance_id and bo.cin7_sale_id = s.cin7_sale_id
left join backorder_po bp on bp.org_id = s.org_id and bp.instance_id = s.instance_id and bp.cin7_sale_id = s.cin7_sale_id;

-- Cheap, aggregate-only — never derives a count from a page of drill-down
-- rows (the exact mistake [[Reporting Architecture]] warns against).
create or replace function report_scorecard_bottleneck_summary(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  queue text,
  current_count integer,
  oldest_age_days integer,
  outside_sla_count integer,
  total_value numeric
) language sql stable set search_path = public as $$
  with base as (
    select * from scorecard_bottleneck_orders_v
    where org_id = p_org_id and (p_instance_ids is null or instance_id = any (p_instance_ids))
  ),
  -- SLA thresholds match the brief's own targets: 1 working day for three
  -- queues, evaluated here as 1 CALENDAR day (a documented simplification —
  -- this schema has no working-day calendar; see the migration header).
  rtp as (
    select
      count(*)::int as current_count,
      max(current_date - order_date)::int as oldest_age_days,
      count(*) filter (where order_date is not null and current_date - order_date > 1)::int as outside_sla_count,
      null::numeric as total_value
    from base where qualifies_ready_to_pick
  ),
  pni as (
    select
      count(*)::int, max(current_date - order_date)::int,
      count(*) filter (where order_date is not null and current_date - order_date > 1)::int,
      sum(invoice_amount)
    from base where qualifies_packed_not_invoiced
  ),
  ins as (
    select
      count(*)::int, max(current_date - latest_invoice_date)::int,
      count(*) filter (where latest_invoice_date is not null and current_date - latest_invoice_date > 1)::int,
      sum(invoice_amount)
    from base where qualifies_invoiced_not_shipped
  ),
  bor as (
    select
      count(*)::int, max(current_date - order_date)::int,
      -- No fixed day threshold in the brief for this queue ("reviewed
      -- daily / ageing controlled") — outside_sla_count is null, not a
      -- guessed cutoff; the UI shows count + oldest age only.
      null::int,
      null::numeric
    from base where qualifies_backorder_awaiting_stock
  )
  select 'ready_to_pick', * from rtp
  union all
  select 'packed_not_invoiced', * from pni
  union all
  select 'invoiced_not_shipped', * from ins
  union all
  select 'backorders_awaiting_stock', * from bor;
$$;

-- Drill-down: the actual orders behind a queue's count. Capped hard at 500
-- rows — a bottleneck queue this large is itself a finding, and this is a
-- card drill-down, not a paged report; raising this needs the same
-- deliberate row-ceiling decision [[Reporting Architecture]] already
-- documents for the reports this pattern is borrowed from, not a silent
-- truncation.
create or replace function report_scorecard_bottleneck_orders(
  p_org_id uuid,
  p_queue text,
  p_instance_ids uuid[] default null
)
returns table (
  cin7_sale_id text,
  instance_id uuid,
  order_number text,
  customer_name text,
  order_date date,
  ship_by date,
  age_days integer,
  relevant_qty numeric,
  invoice_amount numeric,
  has_open_po boolean
) language sql stable set search_path = public as $$
  select
    cin7_sale_id, instance_id, order_number, customer_name, order_date, ship_by,
    case p_queue
      when 'invoiced_not_shipped' then (current_date - latest_invoice_date)
      else (current_date - order_date)
    end as age_days,
    case p_queue
      when 'ready_to_pick' then pickable_qty
      when 'packed_not_invoiced' then greatest(packed_authorised_qty - invoiced_qty, 0)
      when 'invoiced_not_shipped' then invoiced_qty
      when 'backorders_awaiting_stock' then backorder_qty
      else null
    end as relevant_qty,
    invoice_amount,
    has_open_po
  from scorecard_bottleneck_orders_v
  where org_id = p_org_id
    and (p_instance_ids is null or instance_id = any (p_instance_ids))
    and (
      (p_queue = 'ready_to_pick' and qualifies_ready_to_pick)
      or (p_queue = 'packed_not_invoiced' and qualifies_packed_not_invoiced)
      or (p_queue = 'invoiced_not_shipped' and qualifies_invoiced_not_shipped)
      or (p_queue = 'backorders_awaiting_stock' and qualifies_backorder_awaiting_stock)
    )
  order by (ship_by is null) asc, ship_by asc, order_date asc
  limit 500;
$$;
