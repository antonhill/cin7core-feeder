-- LBL Fulfilment & Invoicing brief, Phase P2 — Box Label Print Queue.
--
-- Qualification (brief's own rule, inverted from P1's): a line is ready for
-- a box label when it has an authorised-packed quantity that's now FULLY
-- covered by a final invoice (invoiced_qty >= packed_qty_authorised — the
-- exact complement of P1's ready_to_invoice_qty, which is positive when
-- packed exceeds invoiced). Order-level, also requires the shipping task
-- not already done (qualifies_ship, reused unchanged from 0061/0062).
--
-- Auto-clear via Cin7 attachment [VALIDATE-API], resolved 2026-08-15: a
-- real box-label attachment WAS found live (Spark Demo instance, SO-00128:
-- "BoxLabel+SO-00128+for+Anton.pdf") — the naming convention is real and
-- confirmed. But Cin7SaleAttachment (src/cin7/sales.ts) carries no
-- timestamp field at all, so "added after the qualifying invoice" (the
-- brief's own phrasing) literally cannot be verified — only presence can
-- be checked, not recency. Attachments are also fetched LIVE per sale
-- (never synced — DownloadUrl's signed timeStamp param means it can't be
-- cached), so a bulk per-row Cin7 call for every order in this queue would
-- be the exact N+1-at-list-scale cost this codebase has repeatedly
-- avoided elsewhere (Assemblies' component detail, Order Fulfillment's own
-- "View documents"). Given that, real automatic bulk auto-clear isn't
-- built here — instead: box_label_print_state (below) is the actual v1
-- "drops off the queue" mechanism, a reliable Toolbox-local flag, and the
-- EXISTING on-demand "View documents" fetch (already a per-row, click-
-- triggered call, not a new one) is extended app-side to recognise a
-- BoxLabel-prefixed filename and offer a one-click shortcut to set that
-- same flag — no new eager Cin7 traffic at list-view scale.
create table if not exists box_label_print_state (
  org_id            uuid not null references organizations (id) on delete cascade,
  instance_id       uuid not null references cin7_instances (id) on delete cascade,
  cin7_sale_id      text not null,
  -- Nullable, deliberately unpopulated in v1 — this app's sync doesn't
  -- retain a per-fulfilment TaskID (sale_pick_pack_lines flattens
  -- quantity/status across every Fulfilments[] entry, same SKU-level-not-
  -- fulfilment-level limitation already accepted for P1's
  -- packed_qty_authorised/invoiced_qty). Marking a sale printed today
  -- applies to the whole sale, not a specific fulfilment — a real gap on a
  -- genuinely multi-fulfilment, multi-label order, flagged rather than
  -- silently assumed away. Column kept so a future per-fulfilment tracking
  -- pass doesn't need another migration.
  fulfilment_ref    text,
  printed_by_email  text,
  printed_at        timestamptz not null default clock_timestamp(),
  primary key (org_id, instance_id, cin7_sale_id),
  foreign key (org_id, instance_id, cin7_sale_id) references sales (org_id, instance_id, cin7_sale_id) on delete cascade
);

alter table box_label_print_state enable row level security;
create policy "org members read box_label_print_state" on box_label_print_state for select using (is_org_member(org_id));
-- No write policy — set only via markBoxLabelPrintedAction's service-role client, same convention as every other write table in this app.

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
  packed_qty_authorised numeric,
  invoiced_qty numeric,
  ready_to_invoice_qty numeric,
  -- New for the Box Label queue (P2).
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
  total_ready_to_invoice_qty numeric,
  is_ready_to_invoice boolean,
  ready_to_invoice_hidden_by_floor boolean,
  -- New for Box Label queue (P2).
  invoice_numbers text,
  invoice_coverage_status text,
  total_ready_for_box_label_qty numeric,
  is_ready_for_box_label boolean,
  box_label_hidden_by_floor boolean,
  box_label_printed_at timestamptz,
  box_label_printed_by_email text
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
      sum(ready_for_box_label_qty) as total_ready_for_box_label_qty
    from report_order_fulfillment_lines(p_org_id, p_instance_ids)
    group by cin7_sale_id
  ),
  -- Order-level: distinct FINAL invoice numbers only (same AUTHORISED/PAID
  -- allow-list as invoiced_qty) — requirement 1's "Invoice #(s)" column.
  -- Named distinctly from the "invoice_numbers" OUTPUT column below —
  -- reusing the same name for a CTE and a select-list alias risks Postgres
  -- resolving a later reference to the wrong one.
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
    select org_id, instance_id, cin7_sale_id, printed_at, printed_by_email
    from box_label_print_state
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
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
      inum.numbers as agg_invoice_numbers,
      bl.printed_at as box_label_printed_at,
      bl.printed_by_email as box_label_printed_by_email,
      ci.fulfilment_view_start_date as floor_date,
      coalesce(s.ship_by, s.order_date) as effective_date,
      (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
        and coalesce(t.total_pickable_qty, 0) > 0) as qualifies_pick,
      coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false) as qualifies_ship,
      (coalesce(t.total_ready_to_invoice_qty, 0) > 0) as qualifies_ready_to_invoice,
      -- Box label qualification also requires no local print-state row yet
      -- — that flag is the real "drops off the queue" mechanism (see this
      -- migration's own header comment on why bulk attachment auto-clear
      -- isn't built).
      (coalesce(t.total_ready_for_box_label_qty, 0) > 0
        and coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false)
        and bl.printed_at is null) as qualifies_box_label,
      -- not_invoiced/partially_invoiced/invoiced — requirement 3's filter.
      -- Guards total_ordered_qty > 0 so a line-less order defaults to
      -- not_invoiced rather than a division-adjacent edge case reading as
      -- falsely "invoiced."
      (case
        when coalesce(t.total_ordered_qty, 0) <= 0 or coalesce(t.total_invoiced_qty, 0) <= 0 then 'not_invoiced'
        when t.total_invoiced_qty < t.total_ordered_qty then 'partially_invoiced'
        else 'invoiced'
      end) as invoice_coverage_status
    from sales s
    left join totals t on t.cin7_sale_id = s.cin7_sale_id
    left join invoice_number_agg inum on inum.cin7_sale_id = s.cin7_sale_id
    left join box_label bl on bl.org_id = s.org_id and bl.instance_id = s.instance_id and bl.cin7_sale_id = s.cin7_sale_id
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
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as ready_to_invoice_hidden_by_floor,
    q.agg_invoice_numbers as invoice_numbers,
    q.invoice_coverage_status,
    q.t_total_ready_for_box_label_qty as total_ready_for_box_label_qty,
    (q.qualifies_box_label
      and (q.floor_date is null or q.effective_date is null or q.effective_date >= q.floor_date)) as is_ready_for_box_label,
    (q.qualifies_box_label
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as box_label_hidden_by_floor,
    q.box_label_printed_at,
    q.box_label_printed_by_email
  from qualification q
  order by (q.ship_by is null) asc, q.ship_by asc;
$$;
