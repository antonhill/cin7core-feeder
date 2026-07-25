-- Supplier Planner: genuine per-location demand, not an org-wide aggregate
-- reused across every location. Anton flagged (2026-07-25) that the report
-- showed a location name on a line (Cin7's own per-location supplier-option
-- divergence) while still computing on-hand/velocity/threshold from the
-- WHOLE INSTANCE's stock and sales — so a location's own real position
-- never actually drove the math. product_availability already carries a
-- `location` column; report_reorder (0048) just sums it away.
--
-- A NEW function, not a widened report_reorder — same discipline as
-- report_inventory_movement_lines (0028) sitting alongside
-- report_inventory_movement rather than replacing it: Reorder Report's own
-- established column contract must not regress.
--
-- Known, deliberate limitation: this only attributes SALES to a location
-- (sale_lines joined to sales.location — sales genuinely has one). Assembly
-- consumption (the other source report_reorder's own total_out blends in)
-- is NOT included here — assembly_builds/assembly_consumption_lines carry
-- no location column at all today, even though Cin7's own finished-goods
-- detail response does have a `Location` field (src/cin7/finished-goods.ts)
-- that was never synced/stored. Adding that is a separate follow-up if a
-- client's real demand is meaningfully driven by manufacturing consumption
-- at specific locations, not sales — not built here since it's unconfirmed
-- whether that field is reliably populated on live data.
create or replace function report_supplier_plan_location_demand(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_velocity_date_from date default null,
  p_velocity_date_to date default null
)
returns table (
  product_sku text,
  location text,
  on_hand numeric,
  on_order numeric,
  total_out numeric
) language sql stable set search_path = public as $$
  with availability as (
    select product_sku, location, sum(on_hand) as on_hand, sum(on_order) as on_order
    from product_availability
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
      and location is not null
    group by product_sku, location
  ),
  velocity as (
    select sl.product_sku, s.location, sum(sl.quantity) as total_out
    from sale_lines sl
    join sales s
      on s.org_id = sl.org_id and s.instance_id = sl.instance_id and s.cin7_sale_id = sl.cin7_sale_id
    where sl.org_id = p_org_id
      and (p_instance_ids is null or sl.instance_id = any (p_instance_ids))
      and (p_velocity_date_from is null or sl.invoice_date >= p_velocity_date_from)
      and (p_velocity_date_to is null or sl.invoice_date <= p_velocity_date_to)
      and s.location is not null
    group by sl.product_sku, s.location
  )
  select
    coalesce(a.product_sku, v.product_sku) as product_sku,
    coalesce(a.location, v.location) as location,
    coalesce(a.on_hand, 0) as on_hand,
    coalesce(a.on_order, 0) as on_order,
    coalesce(v.total_out, 0) as total_out
  from availability a
  full outer join velocity v on v.product_sku = a.product_sku and v.location = a.location
  where coalesce(a.product_sku, v.product_sku) is not null;
$$;
