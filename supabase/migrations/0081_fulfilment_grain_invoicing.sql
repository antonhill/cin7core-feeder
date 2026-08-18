-- LBL Fulfilment & Invoicing brief, fulfilment-grain follow-up. LBL's actual
-- flow: the Invoicing Clerk needs to see WHICH fulfilment on a multi-
-- fulfilment Sales Order is ready to invoice (e.g. Fulfilment 1 of 3),
-- without waiting for the other two — P1's `is_ready_to_invoice` (0062)
-- already surfaces the ORDER early once any one fulfilment is packed and
-- authorised (it sums ready_to_invoice_qty across the whole sale), but the
-- queue row itself couldn't say which specific fulfilment was the one
-- that was ready.
--
-- Root cause: sale_pick_pack_lines (0032) deliberately flattened quantity/
-- status across every Fulfilments[] entry — "what matters for 'already
-- picked' is the sum per SKU, not which specific fulfilment record it came
-- from" was true for picking, but not for invoicing readiness. A live probe
-- (2026-08-18, real "Lights by Linea" multi-fulfilment orders) confirmed
-- Cin7 already sends everything needed to fix this without guessing:
--   - Fulfilments[].TaskID: stable, distinct, always populated (18/18
--     real multi-fulfilment orders checked, zero nulls/collisions).
--   - Fulfilments[].FulfillmentNumber / LinkedInvoiceNumber: a genuine
--     two-way cross-reference to Cin7SaleInvoice.InvoiceNumber (confirmed
--     both directions live, e.g. SO-00083's Fulfilments[0].
--     LinkedInvoiceNumber = "INV-00533" and that same invoice's
--     LinkedFulfillmentNumber = "2" matching FulfillmentNumber) — lets
--     invoiced quantity be attributed to the ONE fulfilment it actually
--     covers instead of summed across the whole sale. This matters because
--     the same SKU can appear in more than one sibling fulfilment's
--     Pack.Lines on the same sale (~1/3 of real multi-fulfilment orders
--     checked) — summing by SKU alone across fulfilments would conflate
--     two physically distinct pack events.
--
-- Scope decision: this does NOT re-derive report_order_fulfillment_lines or
-- report_order_fulfillment's existing SKU-grain / order-grain columns —
-- those still correctly serve Pick Today, Ship Today, Backorder, and the
-- Box Label Queue, none of which LBL asked to change, and re-deriving them
-- at fulfilment grain would ripple into row identity/selection state across
-- every tab on the Order Fulfillment page for no requested benefit. Instead
-- this ADDS a fulfilment-level breakdown alongside the existing order-level
-- ready-to-invoice columns (which are unchanged and still correct — "this
-- order has something ready").

alter table sale_pick_pack_lines
  add column if not exists fulfilment_task_id text,
  add column if not exists fulfilment_number int,
  add column if not exists fulfilment_linked_invoice_number text;

-- Every existing row predates this column and will read NULL until its
-- sale's next detail sync — sync-sales.ts does a full delete+reinsert per
-- sale on every detail pass, so this self-heals with no backfill needed;
-- the report logic below simply excludes NULL fulfilment_task_id rows from
-- the new per-fulfilment breakdown (an order whose sale hasn't re-synced
-- yet just shows no fulfilment breakdown, same as before this migration).
create index if not exists sale_pick_pack_lines_fulfilment_idx
  on sale_pick_pack_lines (org_id, instance_id, cin7_sale_id, fulfilment_task_id)
  where fulfilment_task_id is not null;

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
  -- New: which SPECIFIC fulfilment(s) on this order are ready to invoice —
  -- the LBL fulfilment-grain requirement. Null when no fulfilment on this
  -- sale has a positive ready-to-invoice quantity, OR the sale hasn't been
  -- re-synced since fulfilment identity started being captured (see this
  -- migration's own header comment).
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
      sum(ready_for_box_label_qty) as total_ready_for_box_label_qty
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
    select org_id, instance_id, cin7_sale_id, printed_at, printed_by_email
    from box_label_print_state
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
  ),
  -- One row per real fulfilment (grouping by TaskID collapses that
  -- fulfilment's many pick/pack lines back down to a single record) — the
  -- fulfilment's own linked invoice number and authorised-packed quantity,
  -- redundantly stored per line same as the pre-existing `status` column.
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
  -- Invoiced quantity attributed to THIS fulfilment only, via its own
  -- linked_invoice_number — not summed across every invoice on the sale,
  -- which is what makes this safe even when a SKU is split across sibling
  -- fulfilments (see this migration's header comment).
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
        and bl.printed_at is null) as qualifies_box_label,
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
    q.fulfilment_detail as ready_to_invoice_fulfilments,
    q.fulfilment_numbers as ready_to_invoice_fulfilment_numbers
  from qualification q
  order by (q.ship_by is null) asc, q.ship_by asc;
$$;
