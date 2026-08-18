-- Follow-up to migration 0081 (fulfilment_grain_invoicing) / PR #58.
--
-- report_order_fulfillment_lines had no date filter at all — it fetches
-- every sale_order_lines row ever synced for the org/instance, unbounded.
-- LBL's real growth (confirmed live 2026-08-18: 10,297 sales, 28,365 lines
-- for "Lights by Linea" alone) crossed the MAX_RPC_ROWS ceiling on this
-- exact function, breaking Order Fulfillment's "All Orders"/line-detail
-- fetch entirely — a real production outage, unrelated to 0081's own bug
-- (report_order_fulfillment_lines wasn't touched by that migration; this is
-- a separate, genuine scaling limit the client's growth reached).
--
-- Fix has two parts (see src/reports/query.ts's MAX_RPC_ROWS comment for the
-- other one — this migration is the SQL half): add an optional p_from_date
-- to BOTH report_order_fulfillment_lines and report_order_fulfillment,
-- default null so every existing caller (Invoicing Scheduler, Shipping/
-- Picking Calendar, Fulfillment Cleanup Helper, Production Tracking, the
-- home page widgets) is completely unaffected — none of them pass it, so
-- none of them change behavior. Only Order Fulfillment's own page applies a
-- default (client-side, see order-fulfillment/page.tsx), with an explicit
-- "Show all time" control to clear it. Deliberately NOT applied as a
-- server-side default inside these functions themselves — that would
-- silently change every other page's semantics for no request from Anton,
-- exactly the kind of scope creep this codebase's own conventions avoid.
--
-- Date match uses the same "ship_by falling back to order_date, null passes
-- through" convention already used everywhere else in this function for
-- effective_date (P5.3's floor logic) — an order with neither date set is
-- never silently hidden by this filter, matching that precedent exactly.

drop function if exists report_order_fulfillment(uuid, uuid[]);
drop function if exists report_order_fulfillment_lines(uuid, uuid[]);

create function report_order_fulfillment_lines(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null
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
  suggested_pick_location_on_hand numeric,
  backorder_po_number text,
  backorder_eta date,
  backorder_po_outstanding_qty numeric,
  packed_qty_authorised numeric,
  invoiced_qty numeric,
  ready_to_invoice_qty numeric,
  ready_for_box_label_qty numeric
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
  packed_authorised as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pack'
      and status = 'AUTHORISED'
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
  picked_locations as (
    select cin7_sale_id, product_sku, string_agg(distinct location, ', ' order by location) as locations
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pick'
      and location is not null
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
    group by org_id, instance_id, cin7_purchase_id, product_sku
  ),
  purchase_received as (
    select org_id, instance_id, cin7_purchase_id, product_sku, sum(quantity) as received_qty
    from purchase_receipt_lines
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
    coalesce(pk.qty, 0) as picked_qty,
    coalesce(pa.qty, 0) as packed_qty,
    greatest(coalesce(ol.quantity, 0) - coalesce(ol.backorder_quantity, 0) - coalesce(pk.qty, 0), 0) as pickable_qty,
    pl.locations as picked_from_locations,
    bl.location as suggested_pick_location,
    bl.on_hand as suggested_pick_location_on_hand,
    be.order_number as backorder_po_number,
    be.required_by as backorder_eta,
    be.outstanding_qty as backorder_po_outstanding_qty,
    coalesce(pau.qty, 0) as packed_qty_authorised,
    coalesce(inv.qty, 0) as invoiced_qty,
    greatest(coalesce(pau.qty, 0) - coalesce(inv.qty, 0), 0) as ready_to_invoice_qty,
    case when coalesce(pau.qty, 0) > 0 and coalesce(inv.qty, 0) >= coalesce(pau.qty, 0)
      then coalesce(pau.qty, 0) else 0 end as ready_for_box_label_qty
  from sale_order_lines ol
  join sales s on s.org_id = ol.org_id and s.instance_id = ol.instance_id and s.cin7_sale_id = ol.cin7_sale_id
  left join picked pk on pk.cin7_sale_id = ol.cin7_sale_id and pk.product_sku = ol.product_sku
  left join packed pa on pa.cin7_sale_id = ol.cin7_sale_id and pa.product_sku = ol.product_sku
  left join packed_authorised pau on pau.cin7_sale_id = ol.cin7_sale_id and pau.product_sku = ol.product_sku
  left join invoiced inv on inv.cin7_sale_id = ol.cin7_sale_id and inv.product_sku = ol.product_sku
  left join picked_locations pl on pl.cin7_sale_id = ol.cin7_sale_id and pl.product_sku = ol.product_sku
  left join best_location bl on bl.instance_id = ol.instance_id and bl.product_sku = ol.product_sku
  left join backorder_eta be on be.instance_id = ol.instance_id and be.product_sku = ol.product_sku
  where ol.org_id = p_org_id
    and (p_instance_ids is null or ol.instance_id = any (p_instance_ids))
    and (p_from_date is null or coalesce(s.ship_by, s.order_date) is null or coalesce(s.ship_by, s.order_date) >= p_from_date)
  order by ol.cin7_sale_id, ol.line_number;
$$;

create function report_order_fulfillment(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null
)
returns table (
  cin7_sale_id text,
  instance_id uuid,
  order_number text,
  customer_name text,
  customer_reference text,
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
  is_ship_today boolean,
  pick_today_hidden_by_floor boolean,
  ship_today_hidden_by_floor boolean,
  total_ready_to_invoice_qty numeric,
  is_ready_to_invoice boolean,
  ready_to_invoice_hidden_by_floor boolean,
  invoice_numbers text,
  invoice_coverage_status text,
  total_ready_for_box_label_qty numeric,
  is_ready_for_box_label boolean,
  box_label_hidden_by_floor boolean,
  box_label_printed_at timestamptz,
  box_label_printed_by_email text,
  has_backorder_with_po boolean,
  has_backorder_no_po boolean,
  total_packed_qty numeric,
  total_packed_qty_authorised numeric,
  total_invoiced_qty numeric,
  total_backorder_po_outstanding_qty numeric,
  ready_to_invoice_fulfilments jsonb,
  ready_to_invoice_fulfilment_numbers text
) language sql stable set search_path = public as $$
  with totals as (
    select
      cin7_sale_id,
      sum(ordered_qty) as total_ordered_qty,
      sum(backorder_qty) as total_backorder_qty,
      sum(pickable_qty) as total_pickable_qty,
      sum(picked_qty) as total_picked_qty,
      sum(ready_to_invoice_qty) as total_ready_to_invoice_qty,
      sum(invoiced_qty) as total_invoiced_qty,
      sum(ready_for_box_label_qty) as total_ready_for_box_label_qty,
      sum(packed_qty) as total_packed_qty,
      sum(packed_qty_authorised) as total_packed_qty_authorised,
      sum(backorder_po_outstanding_qty) as total_backorder_po_outstanding_qty,
      bool_or(backorder_qty > 0 and backorder_po_number is not null) as has_backorder_with_po,
      bool_or(backorder_qty > 0 and backorder_po_number is null) as has_backorder_no_po
    -- Passing p_from_date through here is belt-and-suspenders, not strictly
    -- required for correctness (any extra sale_ids this returns simply
    -- won't match a row in the date-filtered `sales s` below and get
    -- dropped by the join) — but it avoids computing per-SKU totals for
    -- sales this call doesn't need, matching the whole point of adding the
    -- filter in the first place.
    from report_order_fulfillment_lines(p_org_id, p_instance_ids, p_from_date)
    group by cin7_sale_id
  ),
  invoice_number_agg as (
    select cin7_sale_id, string_agg(distinct invoice_number, ', ' order by invoice_number) as numbers
    from sale_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and invoice_status in ('AUTHORISED', 'PAID')
      and invoice_number is not null
      and invoice_number <> ''
    group by cin7_sale_id
  ),
  box_label as (
    select org_id, instance_id, cin7_sale_id, printed_at, printed_by_email, ready_qty_at_mark
    from box_label_print_state
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
  ),
  fulfilment_packed as (
    select
      cin7_sale_id,
      fulfilment_task_id,
      max(fulfilment_number) as fulfilment_number,
      max(nullif(fulfilment_linked_invoice_number, '')) as linked_invoice_number,
      sum(quantity) filter (where stage = 'pack' and status = 'AUTHORISED') as packed_authorised_qty
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and fulfilment_task_id is not null
    group by cin7_sale_id, fulfilment_task_id
  ),
  fulfilment_computed as (
    select
      fp.cin7_sale_id,
      fp.fulfilment_task_id,
      fp.fulfilment_number,
      fp.linked_invoice_number,
      coalesce(fp.packed_authorised_qty, 0) as packed_authorised_qty,
      coalesce((
        select sum(sl.quantity)
        from sale_lines sl
        where sl.org_id = p_org_id
          and (p_instance_ids is null or sl.instance_id = any (p_instance_ids))
          and sl.cin7_sale_id = fp.cin7_sale_id
          and sl.invoice_number = fp.linked_invoice_number
          and sl.invoice_status in ('AUTHORISED', 'PAID')
      ), 0) as invoiced_qty
    from fulfilment_packed fp
    where coalesce(fp.packed_authorised_qty, 0) > 0
  ),
  fulfilment_ready as (
    select
      cin7_sale_id,
      fulfilment_task_id,
      fulfilment_number,
      linked_invoice_number,
      packed_authorised_qty,
      invoiced_qty,
      greatest(packed_authorised_qty - invoiced_qty, 0) as ready_to_invoice_qty
    from fulfilment_computed
  ),
  fulfilment_agg as (
    select
      cin7_sale_id,
      jsonb_agg(
        jsonb_build_object(
          'fulfilment_task_id', fulfilment_task_id,
          'fulfilment_number', fulfilment_number,
          'linked_invoice_number', linked_invoice_number,
          'packed_authorised_qty', packed_authorised_qty,
          'invoiced_qty', invoiced_qty,
          'ready_to_invoice_qty', ready_to_invoice_qty
        )
        order by fulfilment_number nulls last
      ) filter (where ready_to_invoice_qty > 0) as detail,
      string_agg(
        fulfilment_number::text, ', ' order by fulfilment_number
      ) filter (where ready_to_invoice_qty > 0) as numbers
    from fulfilment_ready
    group by cin7_sale_id
  ),
  qualification as (
    select
      s.*,
      coalesce(t.total_ordered_qty, 0) as t_total_ordered_qty,
      coalesce(t.total_backorder_qty, 0) as t_total_backorder_qty,
      coalesce(t.total_pickable_qty, 0) as t_total_pickable_qty,
      coalesce(t.total_picked_qty, 0) as t_total_picked_qty,
      coalesce(t.total_ready_to_invoice_qty, 0) as t_total_ready_to_invoice_qty,
      coalesce(t.total_invoiced_qty, 0) as t_total_invoiced_qty,
      coalesce(t.total_ready_for_box_label_qty, 0) as t_total_ready_for_box_label_qty,
      coalesce(t.total_packed_qty, 0) as t_total_packed_qty,
      coalesce(t.total_packed_qty_authorised, 0) as t_total_packed_qty_authorised,
      coalesce(t.total_backorder_po_outstanding_qty, 0) as t_total_backorder_po_outstanding_qty,
      coalesce(t.has_backorder_with_po, false) as t_has_backorder_with_po,
      coalesce(t.has_backorder_no_po, false) as t_has_backorder_no_po,
      inum.numbers as agg_invoice_numbers,
      bl.printed_at as box_label_printed_at,
      bl.printed_by_email as box_label_printed_by_email,
      fa.detail as fulfilment_detail,
      fa.numbers as fulfilment_numbers,
      ci.fulfilment_view_start_date as floor_date,
      coalesce(s.ship_by, s.order_date) as effective_date,
      (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
        and coalesce(t.total_pickable_qty, 0) > 0) as qualifies_pick,
      coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false) as qualifies_ship,
      (coalesce(t.total_ready_to_invoice_qty, 0) > 0) as qualifies_ready_to_invoice,
      (coalesce(t.total_ready_for_box_label_qty, 0) > 0
        and coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false)
        and coalesce(t.total_ready_for_box_label_qty, 0) > coalesce(bl.ready_qty_at_mark, 0)) as qualifies_box_label,
      (case
        when coalesce(t.total_ordered_qty, 0) <= 0 or coalesce(t.total_invoiced_qty, 0) <= 0 then 'not_invoiced'
        when t.total_invoiced_qty < t.total_ordered_qty then 'partially_invoiced'
        else 'invoiced'
      end) as invoice_coverage_status
    from sales s
    left join totals t on t.cin7_sale_id = s.cin7_sale_id
    left join invoice_number_agg inum on inum.cin7_sale_id = s.cin7_sale_id
    left join box_label bl on bl.org_id = s.org_id and bl.instance_id = s.instance_id and bl.cin7_sale_id = s.cin7_sale_id
    left join fulfilment_agg fa on fa.cin7_sale_id = s.cin7_sale_id
    left join cin7_instances ci on ci.id = s.instance_id
    where s.org_id = p_org_id
      and (p_instance_ids is null or s.instance_id = any (p_instance_ids))
      -- Same null-safe effective-date convention as pick_today_hidden_by_floor
      -- etc. below — a sale with neither ship_by nor order_date is never
      -- excluded, only ones we can positively confirm are older than the cutoff.
      and (p_from_date is null or coalesce(s.ship_by, s.order_date) is null or coalesce(s.ship_by, s.order_date) >= p_from_date)
  )
  select
    q.cin7_sale_id,
    q.instance_id,
    q.order_number,
    q.customer_name,
    q.customer_reference,
    q.order_date,
    case when q.order_date is not null then (current_date - q.order_date) end as days_open,
    q.ship_by,
    (q.ship_by is not null and q.ship_by < current_date) as is_overdue,
    q.order_status,
    q.combined_picking_status,
    q.combined_packing_status,
    q.combined_shipping_status,
    q.combined_invoice_status,
    q.combined_payment_status,
    q.paid_amount,
    q.invoice_amount,
    q.t_total_ordered_qty as total_ordered_qty,
    q.t_total_backorder_qty as total_backorder_qty,
    q.t_total_pickable_qty as total_pickable_qty,
    q.t_total_picked_qty as total_picked_qty,
    (q.qualifies_pick
      and (q.floor_date is null or q.effective_date is null or q.effective_date >= q.floor_date)) as is_pick_today,
    (q.qualifies_ship
      and (q.floor_date is null or q.effective_date is null or q.effective_date >= q.floor_date)) as is_ship_today,
    (q.qualifies_pick
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as pick_today_hidden_by_floor,
    (q.qualifies_ship
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as ship_today_hidden_by_floor,
    q.t_total_ready_to_invoice_qty as total_ready_to_invoice_qty,
    (q.qualifies_ready_to_invoice
      and (q.floor_date is null or q.effective_date is null or q.effective_date >= q.floor_date)) as is_ready_to_invoice,
    (q.qualifies_ready_to_invoice
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as ready_to_invoice_hidden_by_floor,
    q.agg_invoice_numbers as invoice_numbers,
    q.invoice_coverage_status,
    q.t_total_ready_for_box_label_qty as total_ready_for_box_label_qty,
    (q.qualifies_box_label
      and (q.floor_date is null or q.effective_date is null or q.effective_date >= q.floor_date)) as is_ready_for_box_label,
    (q.qualifies_box_label
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as box_label_hidden_by_floor,
    q.box_label_printed_at,
    q.box_label_printed_by_email,
    q.t_has_backorder_with_po as has_backorder_with_po,
    q.t_has_backorder_no_po as has_backorder_no_po,
    q.t_total_packed_qty as total_packed_qty,
    q.t_total_packed_qty_authorised as total_packed_qty_authorised,
    q.t_total_invoiced_qty as total_invoiced_qty,
    q.t_total_backorder_po_outstanding_qty as total_backorder_po_outstanding_qty,
    q.fulfilment_detail as ready_to_invoice_fulfilments,
    q.fulfilment_numbers as ready_to_invoice_fulfilment_numbers
  from qualification q
  order by (q.ship_by is null) asc, q.ship_by asc;
$$;
