-- Backorders Awaiting Stock: exclude orders that are provably terminal (Rule A).
--
-- Cin7 can leave a stale line-level backorder_quantity on an order that is already
-- fully shipped and fully invoiced (SO-11579: Status COMPLETED, shipped, PAID,
-- invoiced 37 of 37 units, still 34 "backordered"). Trusting that value overstated
-- the Backorders queue. Rule A, approved 2026-10-05: exclude an order from the queue
-- when combined_shipping_status = SHIPPED AND combined_invoice_status is INVOICED or
-- INVOICED / CREDITED. CLOSED / VOIDED are deliberately NOT required.
--
-- Only qualifies_backorder_awaiting_stock changes. Every other column keeps its
-- name, order, type and value; the view stays security_invoker = true; the
-- functions are untouched (they read the qualifier from the view).
--
-- Live effect measured before writing this (all instances): five orders leave the
-- queue — Lights by Linea SO-11579 (34 units), I-Light SO-00014/SO-00043/SO-00091
-- (20/4/5), Spark Demo SO-00222 (1). No order that is only partially shipped or
-- partially invoiced is affected.

create or replace view scorecard_bottleneck_orders_v with (security_invoker = true) as
with ol_sku as (
  select org_id, instance_id, cin7_sale_id, product_sku,
    sum(coalesce(quantity, 0)) as q,
    sum(coalesce(backorder_quantity, 0)) as bo
  from sale_order_lines
  group by org_id, instance_id, cin7_sale_id, product_sku
),
pk as (
  select org_id, instance_id, cin7_sale_id, product_sku, sum(quantity) as qty
  from sale_pick_pack_lines
  where stage = 'pick'
  group by org_id, instance_id, cin7_sale_id, product_sku
),
pickable as (
  select o.org_id, o.instance_id, o.cin7_sale_id,
    sum(greatest(o.q - o.bo - coalesce(pk.qty, 0), 0)) as pickable_qty,
    sum(o.bo) as backorder_qty
  from ol_sku o
  left join pk
    on pk.org_id = o.org_id and pk.instance_id = o.instance_id and pk.cin7_sale_id = o.cin7_sale_id and pk.product_sku = o.product_sku
  group by o.org_id, o.instance_id, o.cin7_sale_id
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
  select o.org_id, o.instance_id, o.cin7_sale_id,
    bool_or(ops.product_sku is not null) as has_open_po
  from ol_sku o
  left join open_po_skus ops on ops.instance_id = o.instance_id and ops.product_sku = o.product_sku
  where o.bo > 0
  group by o.org_id, o.instance_id, o.cin7_sale_id
),
-- One row per pack fulfilment; one scan of the pack stage. pack_qty_authorised is
-- the per-LINE status test of the old packed_authorised CTE, so sales whose lines
-- have no fulfilment id (legacy, never re-synced) are summed exactly as before.
fulfilment_pack as (
  select org_id, instance_id, cin7_sale_id, fulfilment_task_id,
    sum(coalesce(quantity, 0)) as pack_qty,
    sum(quantity) filter (where status = 'AUTHORISED') as pack_qty_authorised,
    max(fulfilment_linked_invoice_number) as linked_invoice,
    max(ship_status) as ship_status,
    max(shipped_at) as shipped_at
  from sale_pick_pack_lines
  where stage = 'pack'
  group by org_id, instance_id, cin7_sale_id, fulfilment_task_id
),
packed_authorised as (
  select org_id, instance_id, cin7_sale_id, sum(pack_qty_authorised) as qty
  from fulfilment_pack
  group by org_id, instance_id, cin7_sale_id
),
-- One row per authorised/paid invoice; one scan of sale_lines.
authorised_invoices as (
  select org_id, instance_id, cin7_sale_id, invoice_number,
    max(invoice_date) as invoice_date,
    sum(coalesce(total, 0)) as invoice_total,
    sum(quantity) as qty
  from sale_lines
  where invoice_status in ('AUTHORISED', 'PAID')
  group by org_id, instance_id, cin7_sale_id, invoice_number
),
invoiced as (
  select org_id, instance_id, cin7_sale_id, sum(qty) as qty, max(invoice_date) as latest_invoice_date
  from authorised_invoices
  group by org_id, instance_id, cin7_sale_id
),
fulfilment_ship_class as (
  select fp.org_id, fp.instance_id, fp.cin7_sale_id, fp.fulfilment_task_id, fp.pack_qty,
    min(ai.invoice_date) as invoice_date, sum(ai.invoice_total) as invoice_total,
    (fp.ship_status is null) as ship_null,
    case
      when fp.ship_status = 'AUTHORISED' and fp.shipped_at is not null then 'shipped'
      when fp.ship_status in ('VOIDED', 'DRAFT', 'NOT AVAILABLE') then 'outstanding'
      else 'unclear'
    end as ship_class
  from fulfilment_pack fp
  join authorised_invoices ai
    on ai.org_id = fp.org_id and ai.instance_id = fp.instance_id and ai.cin7_sale_id = fp.cin7_sale_id
   and ai.invoice_number = any (string_to_array(replace(fp.linked_invoice, ' ', ''), ','))
  where coalesce(fp.linked_invoice, '') <> '' and fp.pack_qty > 0
  group by fp.org_id, fp.instance_id, fp.cin7_sale_id, fp.fulfilment_task_id, fp.pack_qty, fp.ship_status, fp.shipped_at
),
ship_outstanding as (
  select org_id, instance_id, cin7_sale_id,
    sum(pack_qty) filter (where ship_class = 'outstanding') as outstanding_qty,
    min(invoice_date) filter (where ship_class = 'outstanding') as outstanding_since,
    sum(invoice_total) filter (where ship_class = 'outstanding') as outstanding_value,
    sum(pack_qty) filter (where ship_class = 'unclear') as unclear_qty,
    count(*) filter (where ship_class = 'unclear') as unclear_fulfilments,
    sum(pack_qty) filter (where ship_class = 'unclear' and ship_null) as unclear_null_qty,
    count(*) filter (where ship_class = 'unclear' and ship_null) as unclear_null_fulfilments
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
  coalesce(pick.backorder_qty, 0) as backorder_qty,
  coalesce(bp.has_open_po, false) as has_open_po,
  (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
    and coalesce(pick.pickable_qty, 0) > 0) as qualifies_ready_to_pick,
  (greatest(coalesce(pa.qty, 0) - coalesce(inv.qty, 0), 0) > 0) as qualifies_packed_not_invoiced,
  (coalesce(so.outstanding_qty, 0) > 0) as qualifies_invoiced_not_shipped,
  -- Rule A (Anton, 2026-10-05): an order that is BOTH fully shipped AND fully
  -- invoiced cannot have backorder awaiting stock, whatever stale line-level
  -- backorder_quantity Cin7 still carries (SO-11579: completed, shipped, paid,
  -- invoiced 37 of 37, yet 34 units still "backordered"). The order labels are used
  -- strictly to EXCLUDE provably-terminal orders; nothing is qualified by them.
  -- "Fully invoiced" = INVOICED or INVOICED / CREDITED (a credited-but-fully-invoiced
  -- order); PARTIALLY INVOICED variants never match. CLOSED/VOIDED are NOT required.
  (coalesce(pick.backorder_qty, 0) > 0
    and not (coalesce(s.combined_shipping_status = 'SHIPPED', false)
             and coalesce(s.combined_invoice_status in ('INVOICED', 'INVOICED / CREDITED'), false))) as qualifies_backorder_awaiting_stock,
  coalesce(so.outstanding_qty, 0) as ship_outstanding_qty,
  so.outstanding_since as ship_outstanding_since,
  coalesce(so.outstanding_value, 0) as ship_outstanding_value,
  coalesce(so.unclear_qty, 0)
    - case when coalesce(s.combined_shipping_status in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false) then coalesce(so.unclear_null_qty, 0) else 0 end as ship_unclear_qty,
  ((coalesce(so.unclear_fulfilments, 0) - coalesce(so.unclear_null_fulfilments, 0)) > 0
    or (coalesce(so.unclear_null_fulfilments, 0) > 0
        and not coalesce(s.combined_shipping_status in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false))) as qualifies_shipment_state_unclear
from sales s
left join pickable pick on pick.org_id = s.org_id and pick.instance_id = s.instance_id and pick.cin7_sale_id = s.cin7_sale_id
left join packed_authorised pa on pa.org_id = s.org_id and pa.instance_id = s.instance_id and pa.cin7_sale_id = s.cin7_sale_id
left join invoiced inv on inv.org_id = s.org_id and inv.instance_id = s.instance_id and inv.cin7_sale_id = s.cin7_sale_id
left join backorder_po bp on bp.org_id = s.org_id and bp.instance_id = s.instance_id and bp.cin7_sale_id = s.cin7_sale_id
left join ship_outstanding so on so.org_id = s.org_id and so.instance_id = s.instance_id and so.cin7_sale_id = s.cin7_sale_id;
