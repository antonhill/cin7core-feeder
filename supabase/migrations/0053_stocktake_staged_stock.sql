-- Stocktake Assistant: per-(instance, location) picked/packed quantities
-- still staged against open sales — the stock a physical counter won't see
-- on the shelf because it's already been pulled for an outstanding order.
-- Grouped by location (not cin7_sale_id, unlike report_order_fulfillment_lines
-- in 0033) since this tool reconciles a whole stocktake location at once.
-- Excludes shipped/voided orders (same convention as 0034's is_ship_today)
-- since stock on an order that's already shipped has genuinely left the
-- location and shouldn't be added back into a stocktake count.
create or replace function report_stocktake_staged_stock(
  p_org_id uuid,
  p_instance_id uuid,
  p_location text
)
returns table (
  product_sku text,
  product_name text,
  picked_qty numeric,
  packed_qty numeric
) language sql stable set search_path = public as $$
  select
    ppl.product_sku,
    max(ppl.product_name) as product_name,
    sum(ppl.quantity) filter (where ppl.stage = 'pick') as picked_qty,
    sum(ppl.quantity) filter (where ppl.stage = 'pack') as packed_qty
  from sale_pick_pack_lines ppl
  join sales s
    on s.org_id = ppl.org_id
    and s.instance_id = ppl.instance_id
    and s.cin7_sale_id = ppl.cin7_sale_id
  where ppl.org_id = p_org_id
    and ppl.instance_id = p_instance_id
    and ppl.location = p_location
    and ppl.product_sku is not null
    and coalesce(s.combined_shipping_status, '') not in ('SHIPPED', 'VOIDED')
  group by ppl.product_sku
  having sum(ppl.quantity) > 0;
$$;
