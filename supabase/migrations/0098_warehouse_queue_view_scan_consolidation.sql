-- Warehouse Performance queue view: fewer table scans, the Ready-to-Pick
-- duplicate-SKU correctness fix, and ONE call for the whole dashboard.
--
-- WHY (investigated on production-scale LBL data before changing anything):
-- the dashboard intermittently hit PostgREST's 8 s statement timeout. Warm, the
-- queue summary runs in ~0.5 s, but the first call after the cache has gone cold
-- is 3-15 s — it is I/O-bound, not CPU-bound — and the dashboard then made TWO
-- such calls (summary + shipment-unclear), each re-evaluating the whole view.
-- One evaluation touched ~18,700 buffers, and ~55% of that was the `pickable`
-- calculation: a merge join of sale_order_lines (index scan, ~8,300 buffers)
-- against the picked quantities that joined on (instance, sale) only and filtered
-- on product_sku afterwards — 337,615 rows removed by that join filter — plus
-- external sorts spilling to disk (work_mem is ~2 MB). The same tables were also
-- scanned repeatedly: sale_pick_pack_lines x4, sale_order_lines x3, sale_lines x2.
--
-- WHAT CHANGES (the query plan, measured read-only before this was written):
--   * sale_order_lines is aggregated by SKU ONCE (quantity and backorder), then
--     hash-joined to picked quantity on (instance, sale, SKU). This both removes the
--     quadratic join and FIXES Ready to Pick for orders with several lines of the
--     same SKU: picked quantity used to be subtracted from EACH duplicate line, so
--     the remaining quantity was understated (SO-17607: 54 shown, 66 true;
--     SO-20019: 172 shown, 266 true). Aggregating per SKU before subtracting is
--     the correct definition.
--   * backorder_qty and has_open_po are derived from that same per-SKU aggregate
--     (sale_order_lines is scanned once instead of three times).
--   * sale_pick_pack_lines pack stage is scanned once (the per-fulfilment aggregate
--     also yields the authorised-pack quantity); sale_lines once (the per-invoice
--     aggregate also yields the per-sale invoiced quantity and latest date).
--   Result on LBL's volume: ~7,400 buffers instead of ~18,700, no disk-spilling
--   merge join, warm time ~0.4 s for ALL FIVE aggregates versus ~0.5 s for four.
--
-- ONE CALL: report_scorecard_bottleneck_dashboard returns the four queue
-- summaries AND the shipment-unclear count from a single pass over the view, so
-- the dashboard evaluates it once instead of twice. The existing summary /
-- unclear-summary / drill-down functions are unchanged (still used by drill-down
-- and as the reference implementation in the SQL tests).
--
-- Every view column keeps its name, order and type; every non-pickable column's
-- value is identical to 0097 (packed_authorised_qty is summed per line with
-- status AUTHORISED, exactly as before, so legacy rows with no fulfilment id are
-- unaffected). security_invoker = true is retained.

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
  (coalesce(pick.backorder_qty, 0) > 0) as qualifies_backorder_awaiting_stock,
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

-- The whole dashboard in ONE pass over the view: the four KPI queues (same
-- definitions, ages, SLA counts and values as report_scorecard_bottleneck_summary)
-- plus the shipment-unclear count as a fifth row ('shipment_state_unclear', with
-- the unclear quantity in unclear_qty; null for the other rows). Aggregated in a
-- single SELECT with FILTERs so the view's rows are never materialised/spilled.
create or replace function report_scorecard_bottleneck_dashboard(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  queue text,
  current_count integer,
  oldest_age_days integer,
  outside_sla_count integer,
  total_value numeric,
  unclear_qty numeric
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
      coalesce(sum(ship_unclear_qty) filter (where qualifies_shipment_state_unclear), 0) as unc_qty
    from scorecard_bottleneck_orders_v
    where org_id = p_org_id and (p_instance_ids is null or instance_id = any (p_instance_ids))
  )
  select 'ready_to_pick', rtp_n, rtp_oldest, rtp_sla, null::numeric, null::numeric from a
  union all
  select 'packed_not_invoiced', pni_n, pni_oldest, pni_sla, pni_value, null::numeric from a
  union all
  select 'invoiced_not_shipped', ins_n, ins_oldest, ins_sla, ins_value, null::numeric from a
  union all
  select 'backorders_awaiting_stock', bor_n, bor_oldest, null::int, null::numeric, null::numeric from a
  union all
  select 'shipment_state_unclear', unc_n, unc_oldest, null::int, null::numeric, unc_qty from a;
$$;
