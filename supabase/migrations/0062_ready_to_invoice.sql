-- LBL Fulfilment & Invoicing brief, Phase P1 data layer — "Ready to
-- Invoice" queue. Cin7's global order statuses (PACKED/INVOICED/SHIPPED)
-- can't tell apart a sale with a fulfilment that's packed-and-not-yet-
-- invoiced from one that's already fully invoiced, on a multi-fulfilment
-- order — the qualifying signal has to be a real per-SKU quantity
-- comparison, not a status string.
--
-- Both raw quantities needed for that comparison were ALREADY being synced
-- before this migration — packed quantity (sale_pick_pack_lines) and
-- invoiced quantity (sale_lines, from Invoices[].Lines[]) — just missing
-- one thing each: which pack events are actually AUTHORISED (not just
-- attempted) and which invoices are actually final (not DRAFT). Both
-- confirmed live 2026-08-15 against a real multi-fulfilment order
-- (SO-00098, 2 Fulfilments[]) — see sale_pick_pack_lines.status and
-- sale_lines.invoice_status, added just before this migration in the same
-- PR (src/sync/sync-sales.ts).
alter table sale_pick_pack_lines add column if not exists status text;
alter table sale_lines add column if not exists invoice_status text;

-- Postgres won't let create-or-replace change a set-returning function's
-- column list — both need dropping first (report_order_fulfillment calls
-- report_order_fulfillment_lines internally, so it must go too).
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
  suggested_pick_location_on_hand numeric,
  backorder_po_number text,
  backorder_eta date,
  backorder_po_outstanding_qty numeric,
  -- New for Ready to Invoice — see this migration's own header comment.
  packed_qty_authorised numeric,
  invoiced_qty numeric,
  ready_to_invoice_qty numeric
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
  -- Only the pack events whose OWNING fulfilment is actually authorised —
  -- narrower than `packed` above, which counts every attempted pack
  -- regardless of status (that column already has its own established
  -- meaning elsewhere; this is a new, separate aggregate, not a
  -- redefinition of it).
  packed_authorised as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pack'
      and status = 'AUTHORISED'
    group by cin7_sale_id, product_sku
  ),
  -- Allow-list (AUTHORISED/PAID), not a deny-list against VOIDED — see
  -- Cin7SaleInvoice's own doc comment (src/cin7/sales.ts) for why: no
  -- VOIDED example has been confirmed live, so treating "not VOIDED" as
  -- "final" would silently trust an unconfirmed value. A DRAFT invoice
  -- (not yet authorised) correctly does NOT count here, matching the
  -- brief's own qualification rule.
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
    greatest(coalesce(pau.qty, 0) - coalesce(inv.qty, 0), 0) as ready_to_invoice_qty
  from sale_order_lines ol
  left join picked pk on pk.cin7_sale_id = ol.cin7_sale_id and pk.product_sku = ol.product_sku
  left join packed pa on pa.cin7_sale_id = ol.cin7_sale_id and pa.product_sku = ol.product_sku
  left join packed_authorised pau on pau.cin7_sale_id = ol.cin7_sale_id and pau.product_sku = ol.product_sku
  left join invoiced inv on inv.cin7_sale_id = ol.cin7_sale_id and inv.product_sku = ol.product_sku
  left join picked_locations pl on pl.cin7_sale_id = ol.cin7_sale_id and pl.product_sku = ol.product_sku
  left join best_location bl on bl.instance_id = ol.instance_id and bl.product_sku = ol.product_sku
  left join backorder_eta be on be.instance_id = ol.instance_id and be.product_sku = ol.product_sku
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
  -- New for Ready to Invoice.
  total_ready_to_invoice_qty numeric,
  is_ready_to_invoice boolean,
  ready_to_invoice_hidden_by_floor boolean
) language sql stable set search_path = public as $$
  with totals as (
    select
      cin7_sale_id,
      sum(ordered_qty) as total_ordered_qty,
      sum(backorder_qty) as total_backorder_qty,
      sum(pickable_qty) as total_pickable_qty,
      sum(picked_qty) as total_picked_qty,
      sum(ready_to_invoice_qty) as total_ready_to_invoice_qty
    from report_order_fulfillment_lines(p_org_id, p_instance_ids)
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
      ci.fulfilment_view_start_date as floor_date,
      coalesce(s.ship_by, s.order_date) as effective_date,
      (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
        and coalesce(t.total_pickable_qty, 0) > 0) as qualifies_pick,
      coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false) as qualifies_ship,
      -- Deliberately status-independent, same reasoning as is_pick_today/
      -- is_ship_today already being independent of each other (0033's own
      -- comment: pick/pack/ship/invoice don't gate each other in a fixed
      -- sequence on real accounts) — a VOIDED sale can't have a genuine
      -- packed-but-uninvoiced quantity in the first place (packing an
      -- order that was later voided would leave stale pack records, an
      -- edge case no live example has shown yet), so no extra status
      -- filter is layered on top of the quantity comparison itself.
      (coalesce(t.total_ready_to_invoice_qty, 0) > 0) as qualifies_ready_to_invoice
    from sales s
    left join totals t on t.cin7_sale_id = s.cin7_sale_id
    left join cin7_instances ci on ci.id = s.instance_id
    where s.org_id = p_org_id
      and (p_instance_ids is null or s.instance_id = any (p_instance_ids))
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
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as ready_to_invoice_hidden_by_floor
  from qualification q
  order by (q.ship_by is null) asc, q.ship_by asc;
$$;
