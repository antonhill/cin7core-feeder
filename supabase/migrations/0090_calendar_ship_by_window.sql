-- Fixes "report_order_fulfillment_json: canceling statement due to statement
-- timeout" on Shipping Calendar, and the same latent fault on Picking
-- Calendar and Invoicing Scheduler.
--
-- THE DEFECT. All three calendars render a SEVEN DAY grid, and all three
-- fetched the org's ENTIRE order history to do it. None passed any date
-- filter, and none re-fetched on week navigation -- the week was applied in
-- the browser, where `ordersByDay` silently dropped every row outside the
-- visible days. Measured live on the largest org (11,032 sales), warm, three
-- iterations:
--
--     report_order_fulfillment_json(org, null, null)        11,032 rows   14 MB   2,049-4,054ms
--     report_order_fulfillment_lines_json(org, null, null)  30,510 rows   16 MB   1,821-6,410ms
--
-- ~30 MB of JSON per page open, built by two calls issued CONCURRENTLY
-- (Promise.all) -- to render 64 cards. PostgREST's role carries an 8s
-- statement_timeout, and json_agg of an unbounded result set is both the
-- dominant cost and the most variable one (a cold run of the orders call
-- alone measured 6,062ms, spilling to temp files). That variance is why the
-- timeout was intermittent rather than constant.
--
-- THE FIX, in two halves. Neither works alone.
--
-- 1. A ship_by WINDOW on both report functions, so a calendar fetches only
--    the days it is about to draw. Added as new trailing parameters, both
--    defaulting to null, so every existing caller is untouched:
--
--        report_order_fulfillment      (org, instances, from_date, ship_by_from, ship_by_to)
--        report_order_fulfillment_lines(org, instances, from_date, ship_by_from, ship_by_to)
--
--    Plain `s.ship_by >= / <=` comparisons, NOT coalesce(ship_by, order_date)
--    like p_from_date uses. Two reasons, and both matter: the calendars
--    bucket cards on ship_by alone, and coalesce() would make
--    sales_ship_by_idx (org_id, ship_by) unusable. No new index is needed --
--    that one already serves this predicate.
--
-- 2. The window is pushed into the `totals` CTE as well. Without that half,
--    the outer function still aggregates every line the org has ever had
--    before the window can discard anything: measured 861ms of an
--    unwindowed call's ~1,032ms. This is safe for precisely the reason 0083
--    documented when it chose NOT to pass p_from_date there -- the outer
--    `sales s` filter is the sole source of correctness for which orders
--    appear, so narrowing `totals` by the SAME window can only drop rows the
--    LEFT JOIN would never have matched.
--
-- WHY THE BANNERS NEED THEIR OWN FUNCTION. The calendars show two counts
-- that are GLOBAL facts, not window facts:
--
--     "N open order(s) have no Ship By date set - not shown here"
--     "N older orders hidden by the start-date setting"
--
-- A windowed fetch cannot serve these. Measured on the same org: the
-- unscheduled count would have fallen from 4,264 to 106, because 4,158 of
-- those orders have ship_by IS NULL and an order_date older than the window.
-- An order with no ship_by belongs to no window at all, so windowing that
-- count does not narrow it -- it corrupts it.
--
-- report_calendar_banner_counts therefore computes both counts across the
-- full unwindowed set and returns TWO INTEGERS. It is deliberately built on
-- report_order_fulfillment itself rather than reimplementing the
-- qualification predicates: the counts are then exact BY CONSTRUCTION,
-- counting the very same rows the browser used to count, and cannot drift
-- if a qualification rule changes. Measured 1,137-2,294ms (avg ~1,570ms)
-- against the same org, returning ~40 bytes; the point is that it no longer
-- ships 14 MB to count to 4,264. It is now the most expensive of the three
-- calls a calendar makes, with roughly 5x headroom under the 8s ceiling, and
-- it is the one to revisit first if an org's order count grows several-fold.
--
-- Same posture as every sibling: `language sql`, `stable`, `security
-- invoker` (RLS still applies to the caller), `search_path = public`, no
-- grants issued. Adding parameters requires drop-and-recreate rather than
-- CREATE OR REPLACE; the bodies below are generated mechanically from
-- 0087's, NOT retyped, because rebuilding these functions from a stale copy
-- is exactly how 0082 silently reverted 0064's consolidation and how 0081
-- dropped three migrations' worth of columns.

drop function if exists report_order_fulfillment(uuid, uuid[], date);
drop function if exists report_order_fulfillment_lines(uuid, uuid[], date);

create function report_order_fulfillment_lines(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null,
  p_ship_by_from date default null,
  p_ship_by_to date default null
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
  -- ONE pass over sale_pick_pack_lines using FILTER clauses, instead of the
  -- four separate scans (picked / packed / packed_authorised /
  -- picked_locations) this function had. This restores migration 0064's fix,
  -- which migration 0082 silently reverted by rebuilding this function from a
  -- pre-0064 copy of the body. See this migration's header comment.
  with pick_pack as (
    select
      cin7_sale_id,
      product_sku,
      sum(quantity) filter (where stage = 'pick') as picked_qty,
      sum(quantity) filter (where stage = 'pack') as packed_qty,
      sum(quantity) filter (where stage = 'pack' and status = 'AUTHORISED') as packed_authorised_qty,
      string_agg(distinct location, ', ' order by location)
        filter (where stage = 'pick' and location is not null) as picked_locations
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
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
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
    group by org_id, instance_id, cin7_purchase_id, product_sku
  ),
  purchase_received as (
    select org_id, instance_id, cin7_purchase_id, product_sku, sum(quantity) as received_qty
    from purchase_receipt_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
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
    coalesce(pp.picked_qty, 0) as picked_qty,
    coalesce(pp.packed_qty, 0) as packed_qty,
    greatest(coalesce(ol.quantity, 0) - coalesce(ol.backorder_quantity, 0) - coalesce(pp.picked_qty, 0), 0) as pickable_qty,
    pp.picked_locations as picked_from_locations,
    bl.location as suggested_pick_location,
    bl.on_hand as suggested_pick_location_on_hand,
    be.order_number as backorder_po_number,
    be.required_by as backorder_eta,
    be.outstanding_qty as backorder_po_outstanding_qty,
    coalesce(pp.packed_authorised_qty, 0) as packed_qty_authorised,
    coalesce(inv.qty, 0) as invoiced_qty,
    greatest(coalesce(pp.packed_authorised_qty, 0) - coalesce(inv.qty, 0), 0) as ready_to_invoice_qty,
    case when coalesce(pp.packed_authorised_qty, 0) > 0 and coalesce(inv.qty, 0) >= coalesce(pp.packed_authorised_qty, 0)
      then coalesce(pp.packed_authorised_qty, 0) else 0 end as ready_for_box_label_qty
  from sale_order_lines ol
  left join pick_pack pp on pp.cin7_sale_id = ol.cin7_sale_id and pp.product_sku = ol.product_sku
  left join invoiced inv on inv.cin7_sale_id = ol.cin7_sale_id and inv.product_sku = ol.product_sku
  left join best_location bl on bl.instance_id = ol.instance_id and bl.product_sku = ol.product_sku
  left join backorder_eta be on be.instance_id = ol.instance_id and be.product_sku = ol.product_sku
  where ol.org_id = p_org_id
    and (p_instance_ids is null or ol.instance_id = any (p_instance_ids))
    -- Deliberately EXISTS, not a join to `sales` in the FROM clause — see
    -- this migration's header comment. Postgres proves the OR is always
    -- true and skips the EXISTS entirely when p_from_date is null.
    and (
      p_from_date is null
      or exists (
        select 1 from sales s
        where s.org_id = ol.org_id and s.instance_id = ol.instance_id and s.cin7_sale_id = ol.cin7_sale_id
          and (coalesce(s.ship_by, s.order_date) is null or coalesce(s.ship_by, s.order_date) >= p_from_date)
      )
    )
    -- Calendar grid window (0090). Same EXISTS shape 0083 chose over a join,
    -- and for the same reason: when both bounds are null Postgres proves the
    -- OR is always true and drops this from the plan entirely, so every
    -- existing caller keeps its current plan byte for byte. A plain
    -- `s.ship_by` comparison (NOT coalesce(ship_by, order_date)) because the
    -- three calendars bucket cards on ship_by alone -- and because that is
    -- what sales_ship_by_idx (org_id, ship_by) can actually serve; wrapping
    -- it in coalesce() would make the index unusable.
    and (
      (p_ship_by_from is null and p_ship_by_to is null)
      or exists (
        select 1 from sales s
        where s.org_id = ol.org_id and s.instance_id = ol.instance_id and s.cin7_sale_id = ol.cin7_sale_id
          and (p_ship_by_from is null or s.ship_by >= p_ship_by_from)
          and (p_ship_by_to is null or s.ship_by <= p_ship_by_to)
      )
    )
  order by ol.cin7_sale_id, ol.line_number;
$$;

create function report_order_fulfillment(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null,
  p_ship_by_from date default null,
  p_ship_by_to date default null
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
    -- Deliberately always null here, NOT p_from_date — see this migration's
    -- header comment. Correctness for which ORDERS appear still comes from
    -- the date filter on `sales s` below (cheap: a scalar comparison on a
    -- table already being scanned); any sale that filter excludes simply
    -- won't match a row here and gets dropped by that join, same reasoning
    -- 0082 already documented but hadn't yet acted on.
    -- p_from_date stays null here -- 0083's reasoning is unchanged. The
    -- ship_by window IS passed through, and is safe for exactly the reason
    -- 0083 gives for not needing to: the outer `sales s` filter below is
    -- the sole source of correctness for which orders appear, so narrowing
    -- `totals` by the SAME window can only drop rows this LEFT JOIN would
    -- never have matched. Without this the window would leave the outer
    -- function computing every line the org has ever had (measured: 861ms
    -- of an unwindowed call's ~1,032ms) to return one week of orders.
    from report_order_fulfillment_lines(p_org_id, p_instance_ids, null, p_ship_by_from, p_ship_by_to)
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
  -- Invoiced quantity per (sale, invoice_number), aggregated ONCE and then
  -- joined -- previously this was a correlated subquery evaluated per
  -- fulfilment row (migration 0081). Each evaluation scanned sale_lines via
  -- sale_lines_pkey (org_id, instance_id, cin7_sale_id, invoice_number,
  -- line_number) WITHOUT supplying instance_id, so it skipped the index's
  -- second column and scanned a far wider range than it read: measured live
  -- on LBL at 293,506 shared buffer hits to return 685 rows. Set-based, the
  -- same result costs 2,606 buffers (~1,062ms -> ~119ms).
  invoiced_by_invoice as (
    select cin7_sale_id, invoice_number, sum(quantity) as invoiced_qty
    from sale_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and invoice_status in ('AUTHORISED', 'PAID')
      and invoice_number is not null
      and invoice_number <> ''
    group by cin7_sale_id, invoice_number
  ),
  fulfilment_computed as (
    select
      fp.cin7_sale_id,
      fp.fulfilment_task_id,
      fp.fulfilment_number,
      fp.linked_invoice_number,
      coalesce(fp.packed_authorised_qty, 0) as packed_authorised_qty,
      coalesce(ibi.invoiced_qty, 0) as invoiced_qty
    from fulfilment_packed fp
    left join invoiced_by_invoice ibi
      on ibi.cin7_sale_id = fp.cin7_sale_id
      and ibi.invoice_number = fp.linked_invoice_number
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
      and (p_from_date is null or coalesce(s.ship_by, s.order_date) is null or coalesce(s.ship_by, s.order_date) >= p_from_date)
      -- Calendar grid window (0090) -- plain indexed comparisons on
      -- s.ship_by. Orders with no ship_by are excluded by these bounds on
      -- purpose: no calendar has ever rendered a date-less card (all three
      -- skip them when bucketing), and their COUNT is served separately by
      -- report_calendar_banner_counts below so the banner stays exact.
      and (p_ship_by_from is null or s.ship_by >= p_ship_by_from)
      and (p_ship_by_to is null or s.ship_by <= p_ship_by_to)
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


-- The 0089 JSON wrappers, re-created to carry the window through. Body
-- unchanged otherwise -- json_agg (NOT jsonb_agg) and the `limit 75001`
-- ceiling are both load-bearing and both still asserted by tests; see 0089's
-- header for why.
create or replace function report_order_fulfillment_json(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null,
  p_ship_by_from date default null,
  p_ship_by_to date default null
)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    'row_count', count(*),
    'rows', coalesce(json_agg(t), '[]'::json)
  )
  from (
    select * from report_order_fulfillment(p_org_id, p_instance_ids, p_from_date, p_ship_by_from, p_ship_by_to)
    limit 75001
  ) t;
$$;

create or replace function report_order_fulfillment_lines_json(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null,
  p_ship_by_from date default null,
  p_ship_by_to date default null
)
returns json language sql stable set search_path = public as $$
  select json_build_object(
    'row_count', count(*),
    'rows', coalesce(json_agg(t), '[]'::json)
  )
  from (
    select * from report_order_fulfillment_lines(p_org_id, p_instance_ids, p_from_date, p_ship_by_from, p_ship_by_to)
    limit 75001
  ) t;
$$;


-- The two global banner counts, per calendar. Each predicate below is a
-- transcription of the client-side filter that produced the same number
-- before this migration:
--
--   shipping  unscheduled  = shipping-calendar/page.tsx isSchedulable() + !ship_by
--             floor hidden = ship_today_hidden_by_floor
--   picking   unscheduled  = picking-calendar/page.tsx isPickToday() + !ship_by
--             floor hidden = pick_today_hidden_by_floor
--   invoicing unscheduled  = always 0 -- that page has never shown this
--                            banner; it skips date-less orders silently.
--             floor hidden = ready_to_invoice_hidden_by_floor
--
-- An unrecognised p_calendar returns ZERO ROWS (the HAVING below), not a row
-- of zeros -- a typo must surface as a loud "no counts" error in the caller,
-- never as a plausible-looking 0 on screen.
create or replace function report_calendar_banner_counts(
  p_org_id uuid,
  p_calendar text,
  p_instance_ids uuid[] default null
)
returns table (unscheduled_count bigint, floor_hidden_count bigint)
language sql stable set search_path = public as $$
  select
    count(*) filter (where r.ship_by is null and case p_calendar
      when 'shipping' then r.combined_shipping_status is distinct from 'SHIPPED'
                       and r.combined_shipping_status is distinct from 'VOIDED'
                       and not r.ship_today_hidden_by_floor
      when 'picking' then r.is_pick_today
      else false
    end) as unscheduled_count,
    count(*) filter (where case p_calendar
      when 'shipping' then r.ship_today_hidden_by_floor
      when 'picking' then r.pick_today_hidden_by_floor
      when 'invoicing' then r.ready_to_invoice_hidden_by_floor
      else false
    end) as floor_hidden_count
  from report_order_fulfillment(p_org_id, p_instance_ids, null) r
  having p_calendar in ('shipping', 'picking', 'invoicing');
$$;

comment on function report_order_fulfillment(uuid, uuid[], date, date, date) is
  'One row per order. p_ship_by_from/p_ship_by_to bound the result to a ship_by window (plain indexed comparisons, served by sales_ship_by_idx) so the calendars can fetch one week instead of the whole history; both null means no window, the pre-0090 behaviour. Orders with a null ship_by fall outside any window by design - report_calendar_banner_counts counts those.';
comment on function report_order_fulfillment_lines(uuid, uuid[], date, date, date) is
  'Per-SKU detail. Same p_ship_by_from/p_ship_by_to window as report_order_fulfillment, applied as an EXISTS against sales so a null window is proven away by the planner and costs nothing.';
comment on function report_calendar_banner_counts(uuid, text, uuid[]) is
  'The two GLOBAL banner counts (unscheduled / hidden-by-floor) for Shipping Calendar, Picking Calendar and Invoicing Scheduler. Deliberately unwindowed and deliberately built on report_order_fulfillment, so the counts stay exact by construction while returning two integers instead of the 14 MB the pages used to fetch to count them. Returns no rows for an unrecognised p_calendar.';
