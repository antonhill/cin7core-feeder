-- Stock Health report — combines the current-stock snapshot
-- (product_availability, 0030) with outbound velocity/classification
-- already computed for the Inventory Movement report, to surface what
-- Cin7's own Product Availability screen can't: how long stock actually
-- lasts, and which stock is just sitting there.
--
-- Reuses report_inventory_movement_lines (0028, built for the Custom Report
-- Builder) for the velocity side rather than re-deriving the sales/
-- purchases/assembly-builds union logic a third time.
--
-- Both sides use coalesce-across-a-full-outer-join (not a plain inner join)
-- for the same reason report_inventory_movement's own `agg` CTE combines
-- its 4 sources this way: a product can have current stock with zero recent
-- movement (excess/dead stock — the whole point of this report), or real
-- recent sales velocity with NO current stock row at all (a genuine
-- stockout — confirmed live 2026-07-09 that Product Availability still
-- lists a zero-stock row when it has open allocations, but a product with
-- literally nothing recorded anywhere for it could be entirely absent from
-- the snapshot) — an inner join would silently drop either case.
create or replace function report_stock_health(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_velocity_date_from date default null,
  p_velocity_date_to date default null
)
returns table (
  product_sku text,
  product_name text,
  on_hand numeric,
  available numeric,
  stock_value numeric,
  total_out numeric,
  days_of_cover numeric,
  mover_category text,
  status text
) language sql stable set search_path = public as $$
  with availability as (
    select
      product_sku,
      max(product_name) as product_name,
      sum(on_hand) as on_hand,
      sum(available) as available,
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
    c.stock_value,
    c.total_out,
    case
      when p_velocity_date_from is null or p_velocity_date_to is null then null
      when c.total_out <= 0 then null
      else round(c.on_hand / (c.total_out / (p_velocity_date_to - p_velocity_date_from)::numeric), 1)
    end as days_of_cover,
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
  order by c.stock_value desc nulls last;
$$;
