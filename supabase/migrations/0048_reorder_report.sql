-- Reorder Report — the "Local" procurement workflow (threshold-based,
-- no lead time): flags SKUs whose current stock has dropped to or below
-- their recent sales velocity plus a selectable buffer %. Deliberately a
-- SEPARATE top-level function from report_stock_health (0031) rather than
-- widening that one — Stock Health already has its own established column
-- contract and export (src/reports/stock-health-export.ts), so this reuses
-- the same shared low-level building block (report_inventory_movement_lines,
-- 0028) and CTE shape instead, matching how report_stock_health itself sits
-- alongside report_inventory_movement rather than replacing it.
--
-- See the Supplier Planner (Imports workflow, lead-time-based) for the
-- separate tool this deliberately does NOT combine with — Anton confirmed
-- local (simple threshold) and imports (lead-time-aware) should stay as
-- two distinct tools, not one combined report, since they serve different
-- audiences/cadences and a single tool would have to arbitrate which
-- threshold wins when both are configured for the same SKU.
create or replace function report_reorder(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_velocity_date_from date default null,
  p_velocity_date_to date default null,
  p_buffer_percent numeric default 0
)
returns table (
  product_sku text,
  product_name text,
  on_hand numeric,
  available numeric,
  on_order numeric,
  avg_unit_cost numeric,
  total_out numeric,
  weeks_of_cover numeric,
  reorder_threshold numeric,
  needs_reorder boolean,
  mover_category text,
  status text
) language sql stable set search_path = public as $$
  with availability as (
    select
      product_sku,
      max(product_name) as product_name,
      sum(on_hand) as on_hand,
      sum(available) as available,
      sum(on_order) as on_order,
      sum(stock_value) as stock_value
    from product_availability
    where org_id = p_org_id
      and (p_instance_ids is null or instance_id = any (p_instance_ids))
    group by product_sku
  ),
  velocity as (
    select product_sku, sum(quantity) as total_out
    from report_inventory_movement_lines(p_org_id, p_instance_ids, p_velocity_date_from, p_velocity_date_to)
    where source in ('sales', 'assembly_consumption')
    group by product_sku
  ),
  combined as (
    select
      coalesce(a.product_sku, v.product_sku) as product_sku,
      a.product_name,
      coalesce(a.on_hand, 0) as on_hand,
      coalesce(a.available, 0) as available,
      coalesce(a.on_order, 0) as on_order,
      coalesce(a.stock_value, 0) as stock_value,
      coalesce(v.total_out, 0) as total_out
    from availability a
    full outer join velocity v on v.product_sku = a.product_sku
  ),
  ranked as (
    select product_sku, ntile(3) over (order by total_out desc) as bucket
    from combined
    where total_out > 0
  )
  select
    c.product_sku,
    coalesce(p.name, c.product_name) as product_name,
    c.on_hand,
    c.available,
    c.on_order,
    -- Location-blended average — Stock Health has no per-unit cost either;
    -- pulling Cin7's live AverageCost here would reintroduce a live
    -- dependency this report is otherwise entirely free of (pure Postgres).
    case when c.on_hand > 0 then round(c.stock_value / c.on_hand, 2) else null end as avg_unit_cost,
    c.total_out,
    case
      when p_velocity_date_from is null or p_velocity_date_to is null then null
      when c.total_out <= 0 then null
      else round((c.on_hand / (c.total_out / (p_velocity_date_to - p_velocity_date_from)::numeric)) / 7.0, 1)
    end as weeks_of_cover,
    round(c.total_out * (1 + p_buffer_percent / 100.0), 2) as reorder_threshold,
    c.on_hand <= (c.total_out * (1 + p_buffer_percent / 100.0)) as needs_reorder,
    case
      when c.total_out <= 0 then 'No movement'
      when r.bucket = 1 then 'Fast'
      when r.bucket = 2 then 'Medium'
      else 'Slow'
    end as mover_category,
    case
      when c.on_hand <= 0 and c.total_out > 0 then 'Stockout risk'
      when c.stock_value > 0 and (c.total_out <= 0 or r.bucket = 3) then 'Excess'
      else 'Healthy'
    end as status
  from combined c
  left join ranked r using (product_sku)
  left join products p on p.org_id = p_org_id and p.sku = c.product_sku
  where c.product_sku is not null
  order by needs_reorder desc, c.stock_value desc nulls last;
$$;
