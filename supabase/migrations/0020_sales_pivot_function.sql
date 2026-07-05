-- Pivot-grid variant of report_sales_by_product (0019) — instead of a
-- single row per product, groups conditionally by Location and/or Category
-- too, so the app can pivot those values into columns. A CASE expression
-- collapsing to a constant NULL is the standard trick for a toggleable
-- GROUP BY dimension in one SQL function rather than building the query
-- string dynamically in application code.
create or replace function report_sales_pivot(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_location text default null,
  p_category_code text default null,
  p_date_from date default null,
  p_date_to date default null,
  p_group_by_location boolean default false,
  p_group_by_category boolean default false
)
returns table (
  product_sku text,
  product_name text,
  location text,
  category_code text,
  quantity_sold numeric,
  revenue numeric,
  cogs numeric,
  profit numeric,
  margin_percent numeric
) language sql stable set search_path = public as $$
  select
    sl.product_sku,
    max(sl.product_name) as product_name,
    case when p_group_by_location then s.location else null end as location,
    case when p_group_by_category then p.category_code else null end as category_code,
    sum(sl.quantity) as quantity_sold,
    sum(sl.total) as revenue,
    sum(coalesce(sl.average_cost, 0) * coalesce(sl.quantity, 0)) as cogs,
    sum(sl.total) - sum(coalesce(sl.average_cost, 0) * coalesce(sl.quantity, 0)) as profit,
    case when sum(sl.total) = 0 or sum(sl.total) is null then null
         else round(((sum(sl.total) - sum(coalesce(sl.average_cost, 0) * coalesce(sl.quantity, 0))) / sum(sl.total)) * 100, 2)
    end as margin_percent
  from sale_lines sl
  join sales s
    on s.org_id = sl.org_id and s.instance_id = sl.instance_id and s.cin7_sale_id = sl.cin7_sale_id
  left join products p
    on p.org_id = sl.org_id and p.sku = sl.product_sku
  where sl.org_id = p_org_id
    and (p_instance_ids is null or sl.instance_id = any (p_instance_ids))
    and (p_location is null or s.location = p_location)
    and (p_category_code is null or p.category_code = p_category_code)
    and (p_date_from is null or sl.invoice_date >= p_date_from)
    and (p_date_to is null or sl.invoice_date <= p_date_to)
  group by
    sl.product_sku,
    case when p_group_by_location then s.location else null end,
    case when p_group_by_category then p.category_code else null end
  order by sl.product_sku;
$$;
