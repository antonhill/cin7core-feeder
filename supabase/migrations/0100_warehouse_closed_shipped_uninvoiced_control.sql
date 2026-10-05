-- Closed / Shipped but Uninvoiced: a commercial control, kept OUT of the four warehouse
-- KPI queues (approved 2026-10-05, follow-up 4).
--
-- Cases found in LBL's Packed but Not Invoiced queue were not warehouse work at all: six
-- orders (SO-00176, SO-04519, SO-12051, SO-14487, SO-16787, SO-19797) that Cin7 has
-- CLOSED and fully shipped, labelled INVOICED, yet whose packed quantity exceeds what was
-- ever invoiced (1-844 units each, 900 in total). They look like uninvoiced shipments, i.e.
-- a revenue-leak question for the business, not something the warehouse can action.
--
-- The control is DERIVED from a rule, never a list of orders:
--   shipping label SHIPPED
--   AND (order status CLOSED OR invoice label INVOICED / INVOICED / CREDITED)
--   AND authorised packed quantity > invoiced quantity.
-- Orders that are not closed and not labelled fully invoiced (ordinary ready-to-invoice
-- cases: NOT INVOICED / PARTIALLY INVOICED, still AUTHORISED or FULFILLED) stay in Packed
-- but Not Invoiced, which now excludes exactly the control's members.
--
-- Changes: scorecard_bottleneck_orders_v (replaced; two columns APPENDED, qualifies_packed_
-- not_invoiced narrowed; everything else identical, security_invoker kept);
-- report_scorecard_bottleneck_dashboard (dropped and recreated — a return column is added
-- — with a sixth row, closed_shipped_uninvoiced, and a new last column closed_uninvoiced_qty;
-- the existing columns/rows are unchanged so already-deployed callers keep working);
-- report_scorecard_bottleneck_orders (same signature) gains the queue
-- 'closed_shipped_uninvoiced'.
--
-- VALUE is shown only where it can be calculated defensibly: per SKU, the uninvoiced
-- quantity (authorised packed minus invoiced) is priced at that SKU's own average
-- invoiced unit price on the SAME order (invoice line total, ex tax, / quantity). If any
-- uninvoiced SKU has no invoice line on the order to price it from, the order's value is
-- NULL ("not calculable") rather than guessed. The value is computed only for the
-- drill-down of this control (a handful of orders), never for the other queues.

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
  -- Packed but Not Invoiced is NORMAL warehouse-to-invoicing work. Orders Cin7 itself
  -- considers finished (see closed_shipped_uninvoiced below) are a commercial-control
  -- exception, not queue work, so they are carved out here.
  (greatest(coalesce(pa.qty, 0) - coalesce(inv.qty, 0), 0) > 0
    and not (coalesce(s.combined_shipping_status = 'SHIPPED', false)
             and (coalesce(s.order_status = 'CLOSED', false)
                  or coalesce(s.combined_invoice_status in ('INVOICED', 'INVOICED / CREDITED'), false)))) as qualifies_packed_not_invoiced,
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
        and not coalesce(s.combined_shipping_status in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false))) as qualifies_shipment_state_unclear,
  -- "Closed / Shipped but Uninvoiced" (commercial control, outside the four KPI queues):
  -- the order is fully SHIPPED, Cin7 considers it finished (order status CLOSED, or its
  -- invoice label says INVOICED / INVOICED / CREDITED so nothing is left to invoice),
  -- and packed (authorised) quantity still exceeds invoiced quantity. The order labels
  -- DEFINE the exception (it is about Cin7 having closed the book); they say nothing
  -- about warehouse work. Ordinary ready-to-invoice orders (not closed, not labelled
  -- fully invoiced) remain in Packed but Not Invoiced.
  (greatest(coalesce(pa.qty, 0) - coalesce(inv.qty, 0), 0) > 0
    and coalesce(s.combined_shipping_status = 'SHIPPED', false)
    and (coalesce(s.order_status = 'CLOSED', false)
         or coalesce(s.combined_invoice_status in ('INVOICED', 'INVOICED / CREDITED'), false))) as qualifies_closed_shipped_uninvoiced,
  greatest(coalesce(pa.qty, 0) - coalesce(inv.qty, 0), 0) as closed_uninvoiced_qty
from sales s
left join pickable pick on pick.org_id = s.org_id and pick.instance_id = s.instance_id and pick.cin7_sale_id = s.cin7_sale_id
left join packed_authorised pa on pa.org_id = s.org_id and pa.instance_id = s.instance_id and pa.cin7_sale_id = s.cin7_sale_id
left join invoiced inv on inv.org_id = s.org_id and inv.instance_id = s.instance_id and inv.cin7_sale_id = s.cin7_sale_id
left join backorder_po bp on bp.org_id = s.org_id and bp.instance_id = s.instance_id and bp.cin7_sale_id = s.cin7_sale_id
left join ship_outstanding so on so.org_id = s.org_id and so.instance_id = s.instance_id and so.cin7_sale_id = s.cin7_sale_id;

-- A return column is added, which CREATE OR REPLACE cannot do. Drop + create inside this
-- migration's transaction; the only callers are the dashboard action (reads columns by
-- name, so the new column is invisible to already-deployed code) and the SQL tests.
drop function if exists report_scorecard_bottleneck_dashboard(uuid, uuid[]);

create function report_scorecard_bottleneck_dashboard(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  queue text,
  current_count integer,
  oldest_age_days integer,
  outside_sla_count integer,
  total_value numeric,
  unclear_qty numeric,
  closed_uninvoiced_qty numeric
) language sql stable set search_path = public as $$
  with a as (
    select
      count(*) filter (where qualifies_ready_to_pick)::int as rtp_n,
      max(current_date - order_date) filter (where qualifies_ready_to_pick)::int as rtp_oldest,
      count(*) filter (where qualifies_ready_to_pick and order_date is not null and current_date - order_date > 1)::int as rtp_sla,

      count(*) filter (where qualifies_packed_not_invoiced)::int as pni_n,
      max(current_date - order_date) filter (where qualifies_packed_not_invoiced)::int as pni_oldest,
      count(*) filter (where qualifies_packed_not_invoiced and order_date is not null and current_date - order_date > 1)::int as pni_sla,
      sum(invoice_amount) filter (where qualifies_packed_not_invoiced) as pni_value,

      count(*) filter (where qualifies_invoiced_not_shipped)::int as ins_n,
      max(current_date - ship_outstanding_since) filter (where qualifies_invoiced_not_shipped)::int as ins_oldest,
      count(*) filter (where qualifies_invoiced_not_shipped and ship_outstanding_since is not null and current_date - ship_outstanding_since > 1)::int as ins_sla,
      sum(ship_outstanding_value) filter (where qualifies_invoiced_not_shipped) as ins_value,

      count(*) filter (where qualifies_backorder_awaiting_stock)::int as bor_n,
      max(current_date - order_date) filter (where qualifies_backorder_awaiting_stock)::int as bor_oldest,

      count(*) filter (where qualifies_shipment_state_unclear)::int as unc_n,
      max(current_date - latest_invoice_date) filter (where qualifies_shipment_state_unclear)::int as unc_oldest,
      coalesce(sum(ship_unclear_qty) filter (where qualifies_shipment_state_unclear), 0) as unc_qty,

      count(*) filter (where qualifies_closed_shipped_uninvoiced)::int as csu_n,
      max(current_date - order_date) filter (where qualifies_closed_shipped_uninvoiced)::int as csu_oldest,
      coalesce(sum(closed_uninvoiced_qty) filter (where qualifies_closed_shipped_uninvoiced), 0) as csu_qty
    from scorecard_bottleneck_orders_v
    where org_id = p_org_id and (p_instance_ids is null or instance_id = any (p_instance_ids))
  )
  select 'ready_to_pick', rtp_n, rtp_oldest, rtp_sla, null::numeric, null::numeric, null::numeric from a
  union all
  select 'packed_not_invoiced', pni_n, pni_oldest, pni_sla, pni_value, null::numeric, null::numeric from a
  union all
  select 'invoiced_not_shipped', ins_n, ins_oldest, ins_sla, ins_value, null::numeric, null::numeric from a
  union all
  select 'backorders_awaiting_stock', bor_n, bor_oldest, null::int, null::numeric, null::numeric, null::numeric from a
  union all
  select 'shipment_state_unclear', unc_n, unc_oldest, null::int, null::numeric, unc_qty, null::numeric from a
  union all
  select 'closed_shipped_uninvoiced', csu_n, csu_oldest, null::int, null::numeric, null::numeric, csu_qty from a;
$$;

-- Same signature/return type as before; gains the 'closed_shipped_uninvoiced' queue. For that
-- queue only, invoice_amount is the defensibly-priced value of the uninvoiced quantity (see
-- header) or NULL when any uninvoiced SKU cannot be priced from the order's own invoices.
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
    v.cin7_sale_id, v.instance_id, v.order_number, v.customer_name, v.order_date, v.ship_by,
    case p_queue
      when 'invoiced_not_shipped' then (current_date - v.ship_outstanding_since)
      when 'shipment_state_unclear' then (current_date - v.latest_invoice_date)
      else (current_date - v.order_date)
    end as age_days,
    case p_queue
      when 'ready_to_pick' then v.pickable_qty
      when 'packed_not_invoiced' then greatest(v.packed_authorised_qty - v.invoiced_qty, 0)
      when 'invoiced_not_shipped' then v.ship_outstanding_qty
      when 'shipment_state_unclear' then v.ship_unclear_qty
      when 'closed_shipped_uninvoiced' then v.closed_uninvoiced_qty
      when 'backorders_awaiting_stock' then v.backorder_qty
      else null
    end as relevant_qty,
    case p_queue
      when 'invoiced_not_shipped' then v.ship_outstanding_value
      when 'closed_shipped_uninvoiced' then (
        -- Per-SKU: uninvoiced qty x that SKU's average invoiced ex-tax unit price on this order.
        select case when count(*) > 0 and not bool_or(x.unit_price is null) then sum(x.uninvoiced * x.unit_price) end
        from (
          select greatest(p.q - coalesce(i.q, 0), 0) as uninvoiced, i.t / nullif(i.q, 0) as unit_price
          from (
            select pl.product_sku as sku, sum(pl.quantity) as q
            from sale_pick_pack_lines pl
            where pl.org_id = v.org_id and pl.instance_id = v.instance_id and pl.cin7_sale_id = v.cin7_sale_id
              and pl.stage = 'pack' and pl.status = 'AUTHORISED'
            group by pl.product_sku
          ) p
          left join (
            select sl.product_sku as sku, sum(sl.quantity) as q, sum(sl.total) as t
            from sale_lines sl
            where sl.org_id = v.org_id and sl.instance_id = v.instance_id and sl.cin7_sale_id = v.cin7_sale_id
              and sl.invoice_status in ('AUTHORISED', 'PAID')
            group by sl.product_sku
          ) i on i.sku = p.sku
          where greatest(p.q - coalesce(i.q, 0), 0) > 0
        ) x
      )
      else v.invoice_amount
    end as invoice_amount,
    v.has_open_po
  from scorecard_bottleneck_orders_v v
  where v.org_id = p_org_id
    and (p_instance_ids is null or v.instance_id = any (p_instance_ids))
    and (
      (p_queue = 'ready_to_pick' and v.qualifies_ready_to_pick)
      or (p_queue = 'packed_not_invoiced' and v.qualifies_packed_not_invoiced)
      or (p_queue = 'invoiced_not_shipped' and v.qualifies_invoiced_not_shipped)
      or (p_queue = 'shipment_state_unclear' and v.qualifies_shipment_state_unclear)
      or (p_queue = 'closed_shipped_uninvoiced' and v.qualifies_closed_shipped_uninvoiced)
      or (p_queue = 'backorders_awaiting_stock' and v.qualifies_backorder_awaiting_stock)
    )
  order by (v.ship_by is null) asc, v.ship_by asc, v.order_date asc
  limit 500;
$$;
