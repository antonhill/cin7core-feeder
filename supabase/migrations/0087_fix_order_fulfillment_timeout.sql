-- Fixes "report_order_fulfillment: canceling statement due to statement
-- timeout" -- reported live 2026-09-05 for the "I-Light and LBL" org, whose
-- home page (the post-login landing page) rendered as a blank error screen.
--
-- PostgREST connects as `authenticator`, which carries statement_timeout=8s.
-- Measured live before this migration, warm cache, LBL (10,887 sales /
-- 30,113 order lines / 51,051 pick-pack lines):
--
--     report_order_fulfillment          ~4.36s   741,336 shared buffer hits
--     report_order_fulfillment_lines    ~3.63s   145,724 shared buffer hits
--
-- pg_stat_statements confirmed real production calls peaking at 7,932ms /
-- 7,707ms / 7,626ms -- i.e. already brushing the 8s ceiling, so any cold
-- cache or concurrent load tipped individual calls over it.
--
-- Three independent causes, all fixed here. (The fourth -- the home page
-- fetching all 10,887 report rows through 11 paged PostgREST calls, each a
-- full recompute of the whole function, purely to count two booleans -- is
-- fixed in application code plus report_ship_today_counts below.)
--
-- 1. report_order_fulfillment_lines scanned sale_pick_pack_lines FOUR times
--    (picked / packed / packed_authorised / picked_locations). Migration
--    0064 had already consolidated these into a single pass with FILTER
--    clauses, but migration 0082 dropped and recreated this function from a
--    PRE-0064 copy of the body, silently reverting that fix. Nothing failed
--    loudly -- it just got slower again. This is the same class of mistake
--    docs/PROJECT-NOTES.md already records for 0081 on the outer function
--    (rebuilt from an outdated copy, dropping columns three later migrations
--    had added); there it dropped columns, here it dropped a performance fix.
--    Restored.
--
-- 2. report_order_fulfillment's fulfilment_computed CTE (migration 0081) ran
--    a CORRELATED subquery against sale_lines once per fulfilment row. It
--    supplied org_id / cin7_sale_id / invoice_number but not instance_id,
--    skipping the second column of sale_lines_pkey, so each evaluation
--    scanned a much wider index range than it returned. Measured live:
--    293,506 buffer hits for 685 rows (~1,062ms). Rewritten as a single
--    set-based aggregate joined once: 2,606 buffers, ~119ms. Proven
--    equivalent against real LBL data before this migration was written --
--    685 rows both ways, 0 mismatches on a full-join comparison of every
--    (cin7_sale_id, fulfilment_task_id) invoiced quantity.
--
-- 3. purchase_ordered / purchase_received aggregated purchase_order_lines
--    and purchase_receipt_lines with NO org_id filter at all -- every call
--    grouped EVERY org's purchase lines and only discarded the other orgs'
--    rows afterwards, in the downstream join. Dates back to 0035. Scoped to
--    p_org_id / p_instance_ids like every other CTE here. This one grows
--    with the number of tenants, not just with LBL's own data.
--
-- No signature, column, or semantic change to either function: same
-- arguments, same output columns in the same order, same values. This is
-- purely how the rows are computed.

drop function if exists report_order_fulfillment(uuid, uuid[], date);
drop function if exists report_order_fulfillment_lines(uuid, uuid[], date);

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
    -- Deliberately always null here, NOT p_from_date — see this migration's
    -- header comment. Correctness for which ORDERS appear still comes from
    -- the date filter on `sales s` below (cheap: a scalar comparison on a
    -- table already being scanned); any sale that filter excludes simply
    -- won't match a row here and gets dropped by that join, same reasoning
    -- 0082 already documented but hadn't yet acted on.
    from report_order_fulfillment_lines(p_org_id, p_instance_ids, null)
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

-- Cheap counts for the home page's "Ship Today" card, which needs exactly
-- two numbers and previously obtained them by pulling every row of
-- report_order_fulfillment (10,887 rows for LBL = 11 paged PostgREST calls,
-- each one a full ~4.4s recompute of the entire report, ~48s of database
-- work per home page load) and counting two booleans client-side.
--
-- Neither number needs the expensive part. Reading report_order_fulfillment
-- above: is_ship_today is qualifies_ship (a plain sales.combined_shipping_
-- status test) AND the fulfilment_view_start_date floor check, and is_overdue
-- is a plain sales.ship_by test. Neither touches the `totals` CTE, so none of
-- the line-level, pick/pack, invoice or purchase aggregation is required.
-- Both predicates are copied verbatim from report_order_fulfillment above so
-- the two cannot drift; verified live against the real function on LBL data
-- (271 / 6,396 from both). Measured ~11.9ms vs ~4,363ms.
create or replace function report_ship_today_counts(
  p_org_id uuid,
  p_instance_ids uuid[] default null
)
returns table (
  ship_today_count bigint,
  overdue_count bigint
) language sql stable set search_path = public as $$
  select
    count(*) filter (where
      coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false)
      and (ci.fulfilment_view_start_date is null
        or coalesce(s.ship_by, s.order_date) is null
        or coalesce(s.ship_by, s.order_date) >= ci.fulfilment_view_start_date)
    ) as ship_today_count,
    count(*) filter (where s.ship_by is not null and s.ship_by < current_date) as overdue_count
  from sales s
  left join cin7_instances ci on ci.id = s.instance_id
  where s.org_id = p_org_id
    and (p_instance_ids is null or s.instance_id = any (p_instance_ids));
$$;

revoke all on function report_ship_today_counts(uuid, uuid[]) from public;
grant execute on function report_ship_today_counts(uuid, uuid[]) to service_role;
