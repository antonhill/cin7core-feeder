-- Aggregation for the reporting consolidator's per-product view (revenue,
-- COGS, profit, margin%) — done in SQL rather than fetched-and-reduced in
-- application code so the group-by/sum work stays in Postgres as sale_lines
-- grows, instead of pulling every matching line into a server action just to
-- fold it in TypeScript. Called via service-role .rpc() from
-- src/reports/query.ts, same as every other data access in this app — no
-- security definer needed since this is never exposed to the anon/
-- authenticated client directly.
create or replace function report_sales_by_product(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_location text default null,
  p_category_code text default null,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  product_sku text,
  product_name text,
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
    max(p.category_code) as category_code,
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
  group by sl.product_sku
  order by revenue desc nulls last;
$$;
