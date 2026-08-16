-- Follow-up to P2 Box Label Queue: fixes a real gap on multi-fulfilment
-- orders. box_label_print_state was a plain boolean-ish "has this sale
-- ever been marked printed" flag (printed_at is null / is not null) — one
-- row per SALE, since Cin7 gives no reliable way to tie a specific box
-- label attachment to a specific fulfilment (see 0063's own comment: no
-- timestamp on Attachments[], so "added after this invoice" can't be
-- verified). That meant a SECOND fulfilment's box label need (e.g. a
-- backorder that later comes in, gets packed and invoiced) never
-- re-qualified the order for the queue — the underlying ready-for-box-
-- label quantity genuinely grows again, but the sale's printed_at was
-- still set from the FIRST fulfilment's label.
--
-- Fix: instead of a boolean, remember the ready-for-box-label QUANTITY at
-- the moment "Mark as printed" was last clicked (ready_qty_at_mark). The
-- order re-qualifies the moment the live quantity grows PAST that
-- snapshot — self-healing on a genuine new fulfilment, with no per-
-- fulfilment Cin7 tracking needed. (That would mean retaining each
-- Fulfilment's own TaskID through the sync pipeline — a much larger
-- change touching sync-sales.ts/sale_pick_pack_lines/the report functions
-- — and still wouldn't solve tying a specific label FILE to a specific
-- fulfilment, since Cin7's attachment API has no such linkage regardless.)
-- "Unmark" (unmarkBoxLabelPrintedAction) still deletes the row outright
-- for a mistaken click, unaffected by this.
alter table box_label_print_state add column if not exists ready_qty_at_mark numeric not null default 0;

-- Backfill: a bare `default 0` would make every order with ANY currently-
-- positive ready-for-box-label quantity look "newly ready" the instant
-- this ships — including orders that were correctly marked printed and
-- already shipped. Backfill to TODAY's actual ready quantity instead, so
-- nothing looks new until a genuine future fulfilment pushes it higher —
-- same "a new column doesn't get to read as new business by accident"
-- lesson as the invoice_status backfill (see PROJECT-NOTES.md).
with current_ready as (
  select
    bls.org_id,
    bls.instance_id,
    bls.cin7_sale_id,
    coalesce(sum(rofl.ready_for_box_label_qty), 0) as ready_qty
  from box_label_print_state bls
  left join lateral report_order_fulfillment_lines(bls.org_id, array[bls.instance_id]) rofl
    on rofl.cin7_sale_id = bls.cin7_sale_id
  group by bls.org_id, bls.instance_id, bls.cin7_sale_id
)
update box_label_print_state bls
set ready_qty_at_mark = cr.ready_qty
from current_ready cr
where bls.org_id = cr.org_id
  and bls.instance_id = cr.instance_id
  and bls.cin7_sale_id = cr.cin7_sale_id;

drop function if exists report_order_fulfillment(uuid, uuid[]);

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
  total_backorder_po_outstanding_qty numeric
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
    from report_order_fulfillment_lines(p_org_id, p_instance_ids)
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
      ci.fulfilment_view_start_date as floor_date,
      coalesce(s.ship_by, s.order_date) as effective_date,
      (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
        and coalesce(t.total_pickable_qty, 0) > 0) as qualifies_pick,
      coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false) as qualifies_ship,
      (coalesce(t.total_ready_to_invoice_qty, 0) > 0) as qualifies_ready_to_invoice,
      -- Was `bl.printed_at is null` — a plain boolean. Now compares the
      -- live ready quantity against the snapshot taken at the last "Mark
      -- as printed" click, so genuine new growth (a later fulfilment)
      -- re-qualifies the order automatically. coalesce(bl.ready_qty_at_mark, 0)
      -- is 0 when the sale has never been marked at all, which — combined
      -- with the qty > 0 check just above — reproduces the old "never
      -- printed" behavior exactly.
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
    q.box_label_printed_by_email,
    q.t_has_backorder_with_po as has_backorder_with_po,
    q.t_has_backorder_no_po as has_backorder_no_po,
    q.t_total_packed_qty as total_packed_qty,
    q.t_total_packed_qty_authorised as total_packed_qty_authorised,
    q.t_total_invoiced_qty as total_invoiced_qty,
    q.t_total_backorder_po_outstanding_qty as total_backorder_po_outstanding_qty
  from qualification q
  order by (q.ship_by is null) asc, q.ship_by asc;
$$;
