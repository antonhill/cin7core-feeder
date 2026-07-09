-- Sales facts for the custom report builder — same per-line grain as
-- report_sales_by_product (0019), just unaggregated and including
-- category_code, which sale_lines itself doesn't carry a column for (there's
-- no FK from sale_lines to products, unlike sale_lines -> sales, so this
-- can't be expressed as a plain PostgREST embedded join the way
-- getSaleLineDetails' sales!inner join is — needs its own SQL function).
create or replace function report_sales_facts(
  p_org_id uuid,
  p_instance_ids uuid[] default null,
  p_date_from date default null,
  p_date_to date default null
)
returns table (
  product_sku text,
  product_name text,
  category_code text,
  location text,
  customer_name text,
  invoice_date date,
  quantity numeric,
  revenue numeric,
  cogs numeric,
  profit numeric
) language sql stable set search_path = public as $$
  select
    sl.product_sku,
    sl.product_name,
    p.category_code,
    s.location,
    s.customer_name,
    sl.invoice_date,
    sl.quantity,
    sl.total as revenue,
    coalesce(sl.average_cost, 0) * coalesce(sl.quantity, 0) as cogs,
    sl.total - (coalesce(sl.average_cost, 0) * coalesce(sl.quantity, 0)) as profit
  from sale_lines sl
  join sales s
    on s.org_id = sl.org_id and s.instance_id = sl.instance_id and s.cin7_sale_id = sl.cin7_sale_id
  left join products p
    on p.org_id = sl.org_id and p.sku = sl.product_sku
  where sl.org_id = p_org_id
    and (p_instance_ids is null or sl.instance_id = any (p_instance_ids))
    and (p_date_from is null or sl.invoice_date >= p_date_from)
    and (p_date_to is null or sl.invoice_date <= p_date_to);
$$;
