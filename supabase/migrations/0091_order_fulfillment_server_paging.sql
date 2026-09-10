-- Order Fulfillment: server-driven queues, paging, filtering, sorting and
-- search. Fixes "report_order_fulfillment_json: canceling statement due to
-- statement timeout" on Reporting -> Order Fulfillment, which migration 0090
-- did NOT address (0090 windowed the three calendars only).
--
-- THE DEFECT. The page had no pagination at all. It fetched the union of
-- everything its five tabs could need and did every tab, filter, search,
-- sort and count in React. Measured on the largest org at the 12-month
-- default:
--
--     orders  8,533 rows  11 MB  2,075-6,936ms
--     lines  23,571 rows  12 MB  1,629-1,989ms
--
-- ~23 MB per open, two calls concurrently, against an 8s statement_timeout --
-- and "Show all time" is one click away, which takes it to ~30 MB. Yet the
-- tabs that actually do the work are tiny: Pick Today 48 rows, Ship Today
-- 275, Ready to Invoice 34, Box Label Queue 69. All 11 MB exists to serve
-- the one browse tab, and Pick Today is the DEFAULT tab.
--
-- WHY A SECOND PAIR OF FUNCTIONS AND NOT A PARAMETER. The obvious fix -- add
-- an optional p_queue to the existing functions -- was built and measured,
-- and it is NINE TIMES WORSE:
--
--     baseline, no pre-filter                    8,541 rows   1,354ms
--     optional p_queue parameter                   245 cand  12,416ms
--     optional p_sale_ids array parameter        2,421 lines  8,696ms
--     MANDATORY candidate join (this migration)  2,421 lines    333ms
--
-- An optional predicate on a PARAMETER can never be folded away at plan
-- time, so all five queue branches -- including both sale_pick_pack_lines
-- EXISTS -- get planned and evaluated per row even when you ask for one
-- queue. That is exactly the trap 0083 documented for p_from_date: it folds
-- only when the argument is a literal NULL, and an enclosing function passes
-- a parameter. `= any(array)` fails for a related reason: the planner loses
-- cardinality and switches to nested loops.
--
-- The component costs say why the join form wins: every base scan is already
-- cheap (1-46ms, ~107ms total); the ~1,005ms lives in the joins across
-- 30,561 line rows. Pruning only helps if the restriction is a real join the
-- planner can drive from. Hence report_order_fulfillment_lines_fs, whose
-- `want` CTE is joined into all three sale-keyed scans, mandatorily.
--
-- Delegation was considered and rejected: routing the existing unbounded
-- signature through _fs with a full id set measured 2,358ms against 1,155ms
-- today, so it would regress the calendars. Two code paths are genuinely
-- required. The _fs bodies are therefore GENERATED from 0090's, not retyped,
-- and a test asserts their column lists stay identical -- rebuilding these
-- from a stale copy is how 0082 reverted 0064 and how 0081 dropped three
-- migrations' worth of columns.
--
-- RESIDUAL, MEASURED: _fs carries ~170ms of fixed cost regardless of id
-- count (1 id 168ms, 10 ids 169ms) from best_location / purchase_* /
-- backorder_eta, which are keyed by (instance_id, product_sku) rather than
-- by sale and so are not pruned by `want`. A queue tab therefore lands near
-- ~460ms rather than ~200ms. Left alone deliberately: it is a further four
-- join insertions for ~170ms, and worth its own separately-measured change.
--
-- Posture matches every sibling: language sql, stable, security invoker (RLS
-- still applies to the caller), search_path = public, no grants issued.

create function report_order_fulfillment_lines_fs(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_sale_ids text[] default '{}'::text[]
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
  with want as (
    -- MANDATORY, never an optional `p_sale_ids is null or ...`. An optional
    -- predicate on a PARAMETER can never be folded away, so every branch
    -- stays in the plan and the planner cannot drive a join from it.
    -- Measured on the pick queue: optional-param gate 12,416ms,
    -- `= any(array)` 8,696ms, this mandatory join 333ms. Same folding trap
    -- 0083 documented for p_from_date.
    select unnest(p_sale_ids) as want_sale_id
  ),
  pick_pack as (
    select
      cin7_sale_id,
      product_sku,
      sum(quantity) filter (where stage = 'pick') as picked_qty,
      sum(quantity) filter (where stage = 'pack') as packed_qty,
      sum(quantity) filter (where stage = 'pack' and status = 'AUTHORISED') as packed_authorised_qty,
      string_agg(distinct location, ', ' order by location)
        filter (where stage = 'pick' and location is not null) as picked_locations
    from sale_pick_pack_lines
    join want on want.want_sale_id = sale_pick_pack_lines.cin7_sale_id
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
    group by cin7_sale_id, product_sku
  ),
  invoiced as (
    select cin7_sale_id, product_sku, sum(quantity) as qty
    from sale_lines
    join want on want.want_sale_id = sale_lines.cin7_sale_id
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
  join want on want.want_sale_id = ol.cin7_sale_id
  left join pick_pack pp on pp.cin7_sale_id = ol.cin7_sale_id and pp.product_sku = ol.product_sku
  left join invoiced inv on inv.cin7_sale_id = ol.cin7_sale_id and inv.product_sku = ol.product_sku
  left join best_location bl on bl.instance_id = ol.instance_id and bl.product_sku = ol.product_sku
  left join backorder_eta be on be.instance_id = ol.instance_id and be.product_sku = ol.product_sku
  where ol.org_id = p_org_id
    and (p_instance_ids is null or ol.instance_id = any (p_instance_ids))
  order by ol.cin7_sale_id, ol.line_number;
$$;

create function report_order_fulfillment_fs(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_sale_ids text[] default '{}'::text[]
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
    from report_order_fulfillment_lines_fs(p_org_id, p_instance_ids, p_sale_ids)
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
      -- Mandatory. `sales` for one org is ~11k rows and scans in ~5ms,
      -- so = any() is fine HERE; the line-level tables are the ones
      -- that need the join form (see report_order_fulfillment_lines_fs).
      and s.cin7_sale_id = any (p_sale_ids)
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


-- Candidate sale ids covering ALL FOUR queue tabs at once, from `sales` plus
-- two cheap line-level pre-aggregates. Measured 284 candidates in ~200ms
-- against 8,556 orders in the 12-month window.
--
-- ONE set for all four tabs, deliberately: making it per-queue meant an
-- optional-parameter OR, and an optional predicate on a PARAMETER is never
-- folded away, so asking for 'pick' still paid for every other branch.
-- Hydrating 284 rather than 247 is free by comparison.
--
-- Each branch is a strict SUPERSET of the tab predicates it must cover, so
-- pre-filtering is exact rather than approximate:
--   pick branch          covers is_pick_today            + pick_today_hidden_by_floor
--   ship branch          covers is_ship_today            + ship_today_hidden_by_floor
--                        and BOTH box-label predicates, which require the
--                        same shipping-status gate, so box label needs no
--                        branch of its own
--   ready_to_invoice     covers is_ready_to_invoice      + ready_to_invoice_hidden_by_floor
--
-- WHY ready_to_invoice IS COMPUTED PER SKU. is_ready_to_invoice needs
-- sum(greatest(packed_authorised - invoiced, 0)) > 0 per SKU. A sale-level
-- total is NOT a valid superset: per-SKU surpluses and deficits cancel, so a
-- sale whose totals balance can still have a SKU awaiting invoice. The naive
-- cheap gate -- "has any AUTHORISED pack line" -- IS valid but useless here:
-- it matched 4,560 of 8,556 orders. This per-SKU form matches 35.
--
-- NOTE the absence of `fulfilment_task_id is not null`. The outer function's
-- fulfilment_packed CTE has that filter, but report_order_fulfillment_lines'
-- pick_pack CTE does NOT, so packed_authorised_qty can come from pack lines
-- with a null task id. An earlier gate copied the filter across and silently
-- dropped 5 of 69 box-label rows; the per-tab equivalence test caught it.
create function report_order_fulfillment_queue_candidates(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null
)
returns text[] language sql stable set search_path = public as $$
  with dated as (
    select s.cin7_sale_id, s.instance_id, s.combined_picking_status, s.combined_shipping_status
    from sales s
    where s.org_id = p_org_id
      and (p_instance_ids is null or s.instance_id = any (p_instance_ids))
      and (p_from_date is null
           or coalesce(s.ship_by, s.order_date) is null
           or coalesce(s.ship_by, s.order_date) >= p_from_date)
  ),
  packed_auth as (
    select cin7_sale_id, instance_id, product_sku, sum(quantity) as q
    from sale_pick_pack_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and stage = 'pack' and status = 'AUTHORISED'
    group by cin7_sale_id, instance_id, product_sku
  ),
  invoiced as (
    select cin7_sale_id, instance_id, product_sku, sum(quantity) as q
    from sale_lines
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and invoice_status in ('AUTHORISED', 'PAID')
    group by cin7_sale_id, instance_id, product_sku
  ),
  ready_to_invoice as (
    select distinct pa.cin7_sale_id, pa.instance_id
    from packed_auth pa
    left join invoiced iv
      on iv.cin7_sale_id = pa.cin7_sale_id and iv.instance_id = pa.instance_id and iv.product_sku = pa.product_sku
    where pa.q - coalesce(iv.q, 0) > 0
  )
  select coalesce(array_agg(d.cin7_sale_id), '{}'::text[])
  from dated d
  where coalesce(d.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
     or coalesce(d.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false)
     or exists (select 1 from ready_to_invoice r
                where r.cin7_sale_id = d.cin7_sale_id and r.instance_id = d.instance_id);
$$;


-- The five tab badge counts and four hidden-by-floor counts, all exact.
--
-- all_count is a plain `sales` count: report_order_fulfillment returns
-- exactly one row per sales row, so no aggregation is needed for it. The
-- other eight need line quantities, but every one is provably a subset of
-- the queue-candidate union above, so they come from ONE ~284-row hydration
-- instead of the 8,556 the page used to count in the browser.
create function report_order_fulfillment_tab_counts(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null
)
returns table (
  all_count bigint,
  pick_count bigint,
  ship_count bigint,
  ready_to_invoice_count bigint,
  box_label_count bigint,
  pick_floor_count bigint,
  ship_floor_count bigint,
  ready_to_invoice_floor_count bigint,
  box_label_floor_count bigint
) language sql stable set search_path = public as $$
  with q as (
    select * from report_order_fulfillment_fs(
      p_org_id, p_instance_ids,
      report_order_fulfillment_queue_candidates(p_org_id, p_instance_ids, p_from_date))
  )
  select
    (select count(*) from sales s
       where s.org_id = p_org_id
         and (p_instance_ids is null or s.instance_id = any (p_instance_ids))
         and (p_from_date is null
              or coalesce(s.ship_by, s.order_date) is null
              or coalesce(s.ship_by, s.order_date) >= p_from_date)) as all_count,
    count(*) filter (where q.is_pick_today) as pick_count,
    count(*) filter (where q.is_ship_today) as ship_count,
    count(*) filter (where q.is_ready_to_invoice) as ready_to_invoice_count,
    count(*) filter (where q.is_ready_for_box_label) as box_label_count,
    count(*) filter (where q.pick_today_hidden_by_floor) as pick_floor_count,
    count(*) filter (where q.ship_today_hidden_by_floor) as ship_floor_count,
    count(*) filter (where q.ready_to_invoice_hidden_by_floor) as ready_to_invoice_floor_count,
    count(*) filter (where q.box_label_hidden_by_floor) as box_label_floor_count
  from q;
$$;


-- One page of a QUEUE tab (Pick Today / Ship Today / Ready to Invoice / Box
-- Label Queue): {total_count, rows}. Hydrates only the ~284 candidate orders,
-- then applies the tab predicate, all seven filters, the search and the sort
-- before slicing -- a page slice is only correct once everything that narrows
-- the set has been applied.
--
-- SEARCH PARITY. `position(lower(needle) in lower(coalesce(field,''))) > 0`
-- is exactly src/app/reports/text-search.ts's matchesSearch: trim, lowercase,
-- substring. Deliberately not ILIKE '%..%', which would give `%` and `_` in a
-- user's search string wildcard meaning the client never had. The SKU /
-- product-name half is an EXISTS against sale_order_lines, since the page can
-- no longer hold every order's lines.
--
-- SORT PARITY. compareNullable puts nulls last in BOTH directions, so every
-- key says `nulls last` explicitly rather than relying on Postgres's default
-- (nulls-last for asc but nulls-FIRST for desc). Ties fall back to the
-- report's own priority-queue order and then cin7_sale_id, which reproduces
-- JavaScript's stable sort AND makes paging deterministic -- without a unique
-- tiebreaker a row can repeat on one page and vanish from the next.
--
-- KNOWN DIFFERENCE, documented rather than hidden: text ordering uses the
-- database collation where the client used String.localeCompare. These agree
-- on ordinary alphanumeric data but can differ on punctuation and mixed case.
create function report_order_fulfillment_queue_page_json(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null,
  p_queue text default null,
  p_search text default null,
  p_payment_status text default null,
  p_ship_by_from date default null,
  p_ship_by_to date default null,
  p_backorder text default null,
  p_backorder_po text default null,
  p_invoice_coverage text default null,
  p_sort text default null,
  p_sort_dir text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns json language sql stable set search_path = public as $$
  with hydrated as (
    select * from report_order_fulfillment_fs(
      p_org_id, p_instance_ids,
      report_order_fulfillment_queue_candidates(p_org_id, p_instance_ids, p_from_date))
  ),
  tabbed as (
    select * from hydrated r
    where p_queue is null
       or (p_queue = 'pick' and r.is_pick_today)
       or (p_queue = 'ship' and r.is_ship_today)
       or (p_queue = 'invoice' and r.is_ready_to_invoice)
       or (p_queue = 'box_label' and r.is_ready_for_box_label)
  ),
  filtered as (
    select * from tabbed r
    where (p_payment_status is null or p_payment_status = '' or r.combined_payment_status = p_payment_status)
      and (p_ship_by_from is null or (r.ship_by is not null and r.ship_by >= p_ship_by_from))
      and (p_ship_by_to is null or (r.ship_by is not null and r.ship_by <= p_ship_by_to))
      and (p_backorder is null or p_backorder = '' or p_backorder = 'all'
           or (p_backorder = 'fulfillable' and r.total_backorder_qty = 0)
           or (p_backorder = 'backorder' and r.total_backorder_qty > 0))
      and (p_backorder_po is null or p_backorder_po = ''
           or (p_backorder_po = 'with_po' and r.has_backorder_with_po)
           or (p_backorder_po = 'no_po' and r.has_backorder_no_po))
      and (p_invoice_coverage is null or p_invoice_coverage = '' or r.invoice_coverage_status = p_invoice_coverage)
      and (
        p_search is null or btrim(p_search) = ''
        or position(lower(btrim(p_search)) in lower(coalesce(r.order_number, ''))) > 0
        or position(lower(btrim(p_search)) in lower(coalesce(r.customer_name, ''))) > 0
        or exists (
          select 1 from sale_order_lines ol
          where ol.org_id = p_org_id
            and ol.instance_id = r.instance_id
            and ol.cin7_sale_id = r.cin7_sale_id
            and (position(lower(btrim(p_search)) in lower(coalesce(ol.product_sku, ''))) > 0
                 or position(lower(btrim(p_search)) in lower(coalesce(ol.product_name, ''))) > 0)
        )
      )
  ),
  keyed as (
    select r.*,
      case p_sort
        when 'order' then coalesce(r.order_number, r.customer_name)
        when 'shipBy' then r.ship_by::text
        when 'picking' then r.combined_picking_status
        when 'packing' then r.combined_packing_status
        when 'shipping' then r.combined_shipping_status
        when 'invoice' then r.combined_invoice_status
        when 'invoiceNumbers' then r.invoice_numbers
        when 'payment' then r.combined_payment_status
        when 'readyToInvoiceFulfilments' then r.ready_to_invoice_fulfilment_numbers
        else null
      end as sort_txt,
      case p_sort
        when 'pickableNow' then r.total_pickable_qty
        when 'readyToInvoiceQty' then r.total_ready_to_invoice_qty
        when 'boxLabelQty' then r.total_ready_for_box_label_qty
        when 'paidInvoice' then r.paid_amount
        else null
      end as sort_num
    from filtered r
  ),
  page as (
    select * from keyed r
    order by
      case when coalesce(p_sort_dir, 'asc') <> 'desc' then r.sort_num end asc nulls last,
      case when coalesce(p_sort_dir, 'asc') =  'desc' then r.sort_num end desc nulls last,
      case when coalesce(p_sort_dir, 'asc') <> 'desc' then r.sort_txt end asc nulls last,
      case when coalesce(p_sort_dir, 'asc') =  'desc' then r.sort_txt end desc nulls last,
      (r.ship_by is null) asc, r.ship_by asc, r.cin7_sale_id asc
    limit greatest(coalesce(p_limit, 100), 0)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select json_build_object(
    'total_count', (select count(*) from filtered),
    'rows', coalesce((select json_agg(to_jsonb(p) - 'sort_txt' - 'sort_num') from page p), '[]'::json)
  );
$$;

-- One page of the ALL ORDERS tab. Identical filter/search/sort/page logic to
-- report_order_fulfillment_queue_page_json -- the two bodies are generated
-- from one source and a test asserts they stay identical below the hydration
-- CTE, because silently letting them drift is how a filter ends up applying
-- on one tab and not the other.
--
-- The ONLY difference is hydration: this tab has no queue predicate to
-- pre-filter on, so it uses the existing unbounded report_order_fulfillment.
-- Routing it through report_order_fulfillment_fs with a full id set was
-- measured at 2,459ms against 1,354ms, so the id-driven path is actively
-- wrong here. This is why there are two functions rather than one with a
-- scope parameter: a parameterised UNION ALL would execute BOTH hydrations.
create function report_order_fulfillment_all_page_json(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_from_date date default null,
  p_queue text default null,
  p_search text default null,
  p_payment_status text default null,
  p_ship_by_from date default null,
  p_ship_by_to date default null,
  p_backorder text default null,
  p_backorder_po text default null,
  p_invoice_coverage text default null,
  p_sort text default null,
  p_sort_dir text default null,
  p_limit int default 100,
  p_offset int default 0
)
returns json language sql stable set search_path = public as $$
  with hydrated as (
    select * from report_order_fulfillment(p_org_id, p_instance_ids, p_from_date)
  ),
  tabbed as (
    select * from hydrated r
    where p_queue is null
       or (p_queue = 'pick' and r.is_pick_today)
       or (p_queue = 'ship' and r.is_ship_today)
       or (p_queue = 'invoice' and r.is_ready_to_invoice)
       or (p_queue = 'box_label' and r.is_ready_for_box_label)
  ),
  filtered as (
    select * from tabbed r
    where (p_payment_status is null or p_payment_status = '' or r.combined_payment_status = p_payment_status)
      and (p_ship_by_from is null or (r.ship_by is not null and r.ship_by >= p_ship_by_from))
      and (p_ship_by_to is null or (r.ship_by is not null and r.ship_by <= p_ship_by_to))
      and (p_backorder is null or p_backorder = '' or p_backorder = 'all'
           or (p_backorder = 'fulfillable' and r.total_backorder_qty = 0)
           or (p_backorder = 'backorder' and r.total_backorder_qty > 0))
      and (p_backorder_po is null or p_backorder_po = ''
           or (p_backorder_po = 'with_po' and r.has_backorder_with_po)
           or (p_backorder_po = 'no_po' and r.has_backorder_no_po))
      and (p_invoice_coverage is null or p_invoice_coverage = '' or r.invoice_coverage_status = p_invoice_coverage)
      and (
        p_search is null or btrim(p_search) = ''
        or position(lower(btrim(p_search)) in lower(coalesce(r.order_number, ''))) > 0
        or position(lower(btrim(p_search)) in lower(coalesce(r.customer_name, ''))) > 0
        or exists (
          select 1 from sale_order_lines ol
          where ol.org_id = p_org_id
            and ol.instance_id = r.instance_id
            and ol.cin7_sale_id = r.cin7_sale_id
            and (position(lower(btrim(p_search)) in lower(coalesce(ol.product_sku, ''))) > 0
                 or position(lower(btrim(p_search)) in lower(coalesce(ol.product_name, ''))) > 0)
        )
      )
  ),
  keyed as (
    select r.*,
      case p_sort
        when 'order' then coalesce(r.order_number, r.customer_name)
        when 'shipBy' then r.ship_by::text
        when 'picking' then r.combined_picking_status
        when 'packing' then r.combined_packing_status
        when 'shipping' then r.combined_shipping_status
        when 'invoice' then r.combined_invoice_status
        when 'invoiceNumbers' then r.invoice_numbers
        when 'payment' then r.combined_payment_status
        when 'readyToInvoiceFulfilments' then r.ready_to_invoice_fulfilment_numbers
        else null
      end as sort_txt,
      case p_sort
        when 'pickableNow' then r.total_pickable_qty
        when 'readyToInvoiceQty' then r.total_ready_to_invoice_qty
        when 'boxLabelQty' then r.total_ready_for_box_label_qty
        when 'paidInvoice' then r.paid_amount
        else null
      end as sort_num
    from filtered r
  ),
  page as (
    select * from keyed r
    order by
      case when coalesce(p_sort_dir, 'asc') <> 'desc' then r.sort_num end asc nulls last,
      case when coalesce(p_sort_dir, 'asc') =  'desc' then r.sort_num end desc nulls last,
      case when coalesce(p_sort_dir, 'asc') <> 'desc' then r.sort_txt end asc nulls last,
      case when coalesce(p_sort_dir, 'asc') =  'desc' then r.sort_txt end desc nulls last,
      (r.ship_by is null) asc, r.ship_by asc, r.cin7_sale_id asc
    limit greatest(coalesce(p_limit, 100), 0)
    offset greatest(coalesce(p_offset, 0), 0)
  )
  select json_build_object(
    'total_count', (select count(*) from filtered),
    'rows', coalesce((select json_agg(to_jsonb(p) - 'sort_txt' - 'sort_num') from page p), '[]'::json)
  );
$$;

comment on function report_order_fulfillment_lines_fs(uuid, uuid[], text[]) is
  'Per-SKU detail for an EXPLICIT set of cin7_sale_ids. Identical output to report_order_fulfillment_lines for the same orders, but the id list is joined into all three sale-keyed scans so the joins are pruned at source. The restriction is mandatory by design - an optional parameter cannot be folded away and measured 9x WORSE. Carries ~170ms of fixed cost from the SKU-keyed CTEs, which a sale-id list cannot prune.';
comment on function report_order_fulfillment_fs(uuid, uuid[], text[]) is
  'One row per order for an EXPLICIT set of cin7_sale_ids - same 43 columns and same business rules as report_order_fulfillment. Use it for a bounded set only: with a full id set it measured 2,459ms against 1,354ms for the unbounded function.';
comment on function report_order_fulfillment_queue_candidates(uuid, uuid[], date) is
  'Candidate cin7_sale_ids covering all four Order Fulfillment queue tabs (284 of 8,556, ~200ms). Each branch is a strict superset of the tab predicates it covers, so pre-filtering is exact.';
comment on function report_order_fulfillment_tab_counts(uuid, uuid[], date) is
  'The five tab badge counts and four hidden-by-floor counts, exact. all_count is a plain sales count; the other eight are subsets of the queue-candidate union, so they need one ~284-row hydration rather than 8,556.';
comment on function report_order_fulfillment_queue_page_json(uuid, uuid[], date, text, text, text, date, date, text, text, text, text, text, int, int) is
  'One page of a queue tab: {total_count, rows}. Tab, filters, search, sort and slice all applied server-side.';
comment on function report_order_fulfillment_all_page_json(uuid, uuid[], date, text, text, text, date, date, text, text, text, text, text, int, int) is
  'One page of the All Orders tab: {total_count, rows}. Same filter/search/sort/page logic as the queue version; differs only in hydrating via the unbounded report_order_fulfillment, which is faster for an unfiltered set.';
