-- P5.3 (LBL Fulfilment & Invoicing brief): per-org, per-instance date floor
-- on fulfilment queues, so stale pre-cleanup history (2024/early-2025
-- orders, for LBL specifically) stops polluting Pick Today / Ship Today —
-- and, per Anton's explicit call, the Shipping Calendar too, since it's the
-- same underlying "ready to ship" set over a longer horizon.
--
-- Lives on cin7_instances (already the natural per-(org,instance) row) —
-- nullable, defaults to null (no floor), so every existing org/instance is
-- unaffected until they explicitly set one. A dedicated settings table
-- (the purchase_planner_settings shape) wasn't used here since this is a
-- single column on an entity that already exists per-instance, not a new
-- multi-field settings surface.
alter table cin7_instances add column if not exists fulfilment_view_start_date date;

-- The floor never removes a row — "All Orders" must keep seeing everything,
-- per the brief's own instruction that only the queue booleans are gated.
-- An order below the floor still comes back from this function; it just
-- can't be is_pick_today/is_ship_today. The two new *_hidden_by_floor
-- columns are how the UI knows there's something to count in its "N older
-- orders hidden" banner, without re-deriving the qualification logic
-- client-side (which would drift from this function over time).
--
-- Effective date for the floor comparison is ship_by, falling back to
-- order_date when ship_by is null — Anton's call, since the brief flagged
-- this as an open decision: an old UNDATED order is exactly the kind of
-- stale-history noise this setting exists to hide, so it shouldn't get a
-- free pass just for lacking a ship date. If BOTH dates are null (an order
-- somehow synced without either), the floor deliberately does NOT apply —
-- there's no date to judge staleness by, and silently hiding an order with
-- no evidence it's actually old would contradict ground rule 4's "any
-- fallback must be flagged, not hidden."
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
  ship_today_hidden_by_floor boolean
) language sql stable set search_path = public as $$
  with totals as (
    select
      cin7_sale_id,
      sum(ordered_qty) as total_ordered_qty,
      sum(backorder_qty) as total_backorder_qty,
      sum(pickable_qty) as total_pickable_qty,
      sum(picked_qty) as total_picked_qty
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
      ci.fulfilment_view_start_date as floor_date,
      coalesce(s.ship_by, s.order_date) as effective_date,
      (coalesce(s.combined_picking_status not in ('PICKED', 'VOIDED', 'NOT AVAILABLE'), false)
        and coalesce(t.total_pickable_qty, 0) > 0) as qualifies_pick,
      coalesce(s.combined_shipping_status not in ('SHIPPED', 'VOIDED', 'NOT AVAILABLE'), false) as qualifies_ship
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
      and q.floor_date is not null and q.effective_date is not null and q.effective_date < q.floor_date) as ship_today_hidden_by_floor
  from qualification q
  order by (q.ship_by is null) asc, q.ship_by asc;
$$;
