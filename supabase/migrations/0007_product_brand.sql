-- Brand exists as a column in Cin7's own InventoryList CSV template and as a
-- field on the live Product resource, but was never modeled at all — the
-- push payload simply never sent it, so Cin7 silently kept whatever value
-- (or none) was already there, which read as "Brand doesn't update."
alter table products add column if not exists brand text;

-- Backfill from the most recent committed products-import row per SKU,
-- where the original Brand value still exists — recovers real brand data
-- for products already imported before this column existed (Brand was
-- silently discarded on import too, not just on push).
update products p set brand = sub.raw_brand
from (
  select distinct on (b.org_id, ir.raw->>'ProductCode')
    b.org_id as org_id, ir.raw->>'ProductCode' as sku, ir.raw->>'Brand' as raw_brand
  from import_rows ir
  join import_batches b on b.id = ir.batch_id
  where b.kind = 'products' and ir.status = 'committed' and coalesce(ir.raw->>'Brand', '') <> ''
  order by b.org_id, ir.raw->>'ProductCode', b.created_at desc
) sub
where p.org_id = sub.org_id and p.sku = sub.sku;

create or replace function recompute_product_hash(p_org_id uuid, p_sku text)
returns void language sql set search_path = public as $$
  update products p set
    content_hash = md5(
      coalesce(p.name,'') || '|' || coalesce(p.description,'') || '|' ||
      coalesce(p.category_code,'') || '|' || coalesce(p.brand,'') || '|' ||
      coalesce(p.uom_code,'') || '|' ||
      coalesce(p.barcode,'') || '|' || coalesce(p.cin7_type,'') || '|' ||
      coalesce(p.tax_code,'') || '|' || p.active::text || '|' || coalesce(p.status,'') || '|' ||
      coalesce(p.costing_method,'') || '|' ||
      coalesce((select string_agg(tier_code||':'||amount||':'||currency, ',' order by tier_code)
                from price_tiers where org_id = p.org_id and product_sku = p.sku), '') || '|' ||
      coalesce((select string_agg(component_sku||':'||quantity||':'||coalesce(cost_percentage,0), ',' order by component_sku)
                from assembly_bom_lines where org_id = p.org_id and product_sku = p.sku), '')
    ),
    updated_at = now()
  where p.org_id = p_org_id and p.sku = p_sku;
$$;

drop trigger if exists products_touch on products;
create trigger products_touch after insert or update of
  name, description, category_code, brand, uom_code, barcode, type, cin7_type, tax_code, active, status, costing_method
  on products for each row execute function trg_product_touch();

-- Bump every existing product's hash so a future re-import (which will now
-- populate brand from the CSV) is detected as a real change and re-pushed.
select recompute_product_hash(org_id, sku) from products;
