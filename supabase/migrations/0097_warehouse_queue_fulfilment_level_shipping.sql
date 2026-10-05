-- Warehouse Performance bottleneck queues — "Invoiced but Not Shipped" is
-- now defined from FULFILMENT-LEVEL outstanding work, not from the order-level
-- shipping label. Depends on 0096 (sale_pick_pack_lines.ship_status/shipped_at)
-- and on the sync populating them.
--
-- Principle (LBL): a bottleneck queue must describe the OUTSTANDING QUANTITY,
-- not infer it from the overall sales-order status. SO-19948 (invoiced 8,
-- shipped 8, backordered 1) must NOT be in Invoiced but Not Shipped; it stays in
-- Backorders Awaiting Stock with qty 1.
--
-- Per INVOICED fulfilment (a pack fulfilment whose linked invoice is an
-- AUTHORISED/PAID invoice on the sale), classified by its persisted Ship state:
--   ship_status = AUTHORISED and shipped_at is not null  -> SHIPPED (qty 0 outstanding)
--   ship_status in (VOIDED, DRAFT, NOT AVAILABLE)        -> shipped qty 0 -> OUTSTANDING
--   anything else: NULL (not yet synced), PARTIALLY AUTHORISED (no safe quantity
--   derivation proven), AUTHORISED without a shipment date, or a value we have
--   never seen                                           -> UNCLEAR
-- UNCLEAR fulfilments never count as shipped or unshipped: they are excluded
-- from the queue's KPI totals and surfaced separately as "shipment state
-- unclear" until resolved.
--
-- Outstanding quantity = the fulfilment's PACK quantity (Cin7 Ship lines carry
-- no quantity). The queue's relevant_qty is that outstanding quantity — not the
-- order's total invoiced quantity.
--
-- Also corrected here, because they were derived from whole-order figures that
-- overstate partial work: the queue's age (now the oldest OUTSTANDING
-- fulfilment's own invoice date) and its value (now the invoice total of the
-- outstanding fulfilments' linked invoices, not the whole order's
-- invoice_amount).
--
-- The other three queues' definitions are deliberately UNCHANGED by this
-- migration; they are audited separately and any change is its own decision.
--
-- Constraints carried forward from 0093: the view stays WITH (security_invoker
-- = true) (it reads RLS-protected sales; see 0093's header for the leak this
-- prevents), existing view columns keep their names/order/types (new ones are
-- appended), and both existing functions keep their signatures so nothing is
-- dropped. The new CTEs scan sale_pick_pack_lines/sale_lines once each; see the
-- migration's PR for before/after EXPLAIN ANALYZE on LBL's volume.

create or replace view scorecard_bottleneck_orders_v with (security_invoker = true) as
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
),
-- One row per pack fulfilment. ship_status/shipped_at are denormalised onto every
-- line of a fulfilment, so max() simply reads that single value back.
fulfilment_pack as (
  select org_id, instance_id, cin7_sale_id, fulfilment_task_id,
    sum(coalesce(quantity, 0)) as pack_qty,
    max(fulfilment_linked_invoice_number) as linked_invoice,
    max(ship_status) as ship_status,
    max(shipped_at) as shipped_at
  from sale_pick_pack_lines
  where stage = 'pack'
  group by org_id, instance_id, cin7_sale_id, fulfilment_task_id
),
-- A fulfilment is "invoiced" only when its linked invoice is a real
-- (AUTHORISED/PAID) invoice on the sale — a DRAFT invoice is not invoiced.
authorised_invoices as (
  select org_id, instance_id, cin7_sale_id, invoice_number,
    max(invoice_date) as invoice_date,
    sum(coalesce(total, 0)) as invoice_total
  from sale_lines
  where invoice_status in ('AUTHORISED', 'PAID')
  group by org_id, instance_id, cin7_sale_id, invoice_number
),
fulfilment_ship_class as (
  select fp.org_id, fp.instance_id, fp.cin7_sale_id, fp.pack_qty, ai.invoice_date, ai.invoice_total,
    case
      when fp.ship_status = 'AUTHORISED' and fp.shipped_at is not null then 'shipped'
      when fp.ship_status in ('VOIDED', 'DRAFT', 'NOT AVAILABLE') then 'outstanding'
      else 'unclear'
    end as ship_class
  from fulfilment_pack fp
  join authorised_invoices ai
    on ai.org_id = fp.org_id and ai.instance_id = fp.instance_id and ai.cin7_sale_id = fp.cin7_sale_id
   and ai.invoice_number = fp.linked_invoice
  where coalesce(fp.linked_invoice, '') <> '' and fp.pack_qty > 0
),
ship_outstanding as (
  select org_id, instance_id, cin7_sale_id,
    sum(pack_qty) filter (where ship_class = 'outstanding') as outstanding_qty,
    min(invoice_date) filter (where ship_class = 'outstanding') as outstanding_since,
    sum(invoice_total) filter (where ship_class = 'outstanding') as outstanding_value,
    sum(pack_qty) filter (where ship_class = 'unclear') as unclear_qty,
    count(*) filter (where ship_class = 'unclear') as unclear_fulfilments
  from fulfilment_ship_class
  group by org_id, instance_id, cin7_sale_id
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
  (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
    and coalesce(pick.pickable_qty, 0) > 0) as qualifies_ready_to_pick,
  (greatest(coalesce(pa.qty, 0) - coalesce(inv.qty, 0), 0) > 0) as qualifies_packed_not_invoiced,
  -- Fulfilment-level outstanding work only. Deliberately NOT the order-level
  -- combined_shipping_status (PARTIALLY SHIPPED / SHIPPING says nothing about
  -- which quantity is outstanding).
  (coalesce(so.outstanding_qty, 0) > 0) as qualifies_invoiced_not_shipped,
  (coalesce(bo.qty, 0) > 0) as qualifies_backorder_awaiting_stock,
  -- Appended columns (existing columns above keep their order/names/types).
  coalesce(so.outstanding_qty, 0) as ship_outstanding_qty,
  so.outstanding_since as ship_outstanding_since,
  coalesce(so.outstanding_value, 0) as ship_outstanding_value,
  coalesce(so.unclear_qty, 0) as ship_unclear_qty,
  (coalesce(so.unclear_fulfilments, 0) > 0) as qualifies_shipment_state_unclear
from sales s
left join pickable pick on pick.org_id = s.org_id and pick.instance_id = s.instance_id and pick.cin7_sale_id = s.cin7_sale_id
left join packed_authorised pa on pa.org_id = s.org_id and pa.instance_id = s.instance_id and pa.cin7_sale_id = s.cin7_sale_id
left join invoiced inv on inv.org_id = s.org_id and inv.instance_id = s.instance_id and inv.cin7_sale_id = s.cin7_sale_id
left join backorders bo on bo.org_id = s.org_id and bo.instance_id = s.instance_id and bo.cin7_sale_id = s.cin7_sale_id
left join backorder_po bp on bp.org_id = s.org_id and bp.instance_id = s.instance_id and bp.cin7_sale_id = s.cin7_sale_id
left join ship_outstanding so on so.org_id = s.org_id and so.instance_id = s.instance_id and so.cin7_sale_id = s.cin7_sale_id;

-- Same signature/return type as 0093 (so no drop). Four rows, exactly as before:
-- the "shipment state unclear" count is a separate function below so the
-- four KPI queues stay a stable shape.
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
  -- Age and value describe the OUTSTANDING fulfilments only (see header).
  ins as (
    select
      count(*)::int, max(current_date - ship_outstanding_since)::int,
      count(*) filter (where ship_outstanding_since is not null and current_date - ship_outstanding_since > 1)::int,
      sum(ship_outstanding_value)
    from base where qualifies_invoiced_not_shipped
  ),
  bor as (
    select
      count(*)::int, max(current_date - order_date)::int,
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

-- Orders whose ship state cannot be classified (not yet synced, PARTIALLY
-- AUTHORISED, ...) — excluded from every KPI total above, surfaced here.
create or replace function report_scorecard_shipment_unclear_summary(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  current_count integer,
  oldest_age_days integer,
  unclear_qty numeric
) language sql stable set search_path = public as $$
  select
    count(*)::int,
    max(current_date - latest_invoice_date)::int,
    coalesce(sum(ship_unclear_qty), 0)
  from scorecard_bottleneck_orders_v
  where org_id = p_org_id
    and (p_instance_ids is null or instance_id = any (p_instance_ids))
    and qualifies_shipment_state_unclear;
$$;

-- Same signature/return type as 0093. relevant_qty for invoiced_not_shipped is
-- now the OUTSTANDING quantity; a new p_queue value, shipment_state_unclear,
-- lists the orders behind the unclear count (relevant_qty = the unclear packed
-- quantity).
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
      when 'invoiced_not_shipped' then (current_date - ship_outstanding_since)
      when 'shipment_state_unclear' then (current_date - latest_invoice_date)
      else (current_date - order_date)
    end as age_days,
    case p_queue
      when 'ready_to_pick' then pickable_qty
      when 'packed_not_invoiced' then greatest(packed_authorised_qty - invoiced_qty, 0)
      when 'invoiced_not_shipped' then ship_outstanding_qty
      when 'shipment_state_unclear' then ship_unclear_qty
      when 'backorders_awaiting_stock' then backorder_qty
      else null
    end as relevant_qty,
    case p_queue
      when 'invoiced_not_shipped' then ship_outstanding_value
      else invoice_amount
    end as invoice_amount,
    has_open_po
  from scorecard_bottleneck_orders_v
  where org_id = p_org_id
    and (p_instance_ids is null or instance_id = any (p_instance_ids))
    and (
      (p_queue = 'ready_to_pick' and qualifies_ready_to_pick)
      or (p_queue = 'packed_not_invoiced' and qualifies_packed_not_invoiced)
      or (p_queue = 'invoiced_not_shipped' and qualifies_invoiced_not_shipped)
      or (p_queue = 'shipment_state_unclear' and qualifies_shipment_state_unclear)
      or (p_queue = 'backorders_awaiting_stock' and qualifies_backorder_awaiting_stock)
    )
  order by (ship_by is null) asc, ship_by asc, order_date asc
  limit 500;
$$;
