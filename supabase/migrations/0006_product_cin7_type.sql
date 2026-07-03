-- Cin7's own Type value (Stock/Service/Non-Inventory/BillOfMaterials) was
-- being lossily reconstructed on push/export from our internal 5-value
-- product_type enum — both Stock and Service collapse to "component" on
-- import, then reverse-map back to "Stock" always, silently converting
-- Service products to Stock on every sync (confirmed live: a Service labour
-- SKU came back as Stock in Cin7 after a push). Store the raw CSV Type value
-- verbatim (same pattern as `status` vs `active`) and push/export that
-- instead of the lossy enum.
alter table products add column if not exists cin7_type text not null default 'Stock';

-- Backfill from the most recent committed products-import row per SKU, where
-- the original Type value still exists — recovers e.g. "Service" for
-- products already collapsed to "component" by the lossy enum before this
-- column existed.
update products p set cin7_type = sub.raw_type
from (
  select distinct on (b.org_id, ir.raw->>'ProductCode')
    b.org_id as org_id, ir.raw->>'ProductCode' as sku, ir.raw->>'Type' as raw_type
  from import_rows ir
  join import_batches b on b.id = ir.batch_id
  where b.kind = 'products' and ir.status = 'committed' and coalesce(ir.raw->>'Type', '') <> ''
  order by b.org_id, ir.raw->>'ProductCode', b.created_at desc
) sub
where p.org_id = sub.org_id and p.sku = sub.sku;

-- Recompute content_hash using cin7_type (accurate) instead of the lossy
-- `type` enum going forward.
create or replace function recompute_product_hash(p_org_id uuid, p_sku text)
returns void language sql set search_path = public as $$
  update products p set
    content_hash = md5(
      coalesce(p.name,'') || '|' || coalesce(p.description,'') || '|' ||
      coalesce(p.category_code,'') || '|' || coalesce(p.uom_code,'') || '|' ||
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
  name, description, category_code, uom_code, barcode, type, cin7_type, tax_code, active, status, costing_method
  on products for each row execute function trg_product_touch();

-- Bump every product's hash so the corrected cin7_type is reflected
-- immediately rather than waiting for an unrelated future edit.
select recompute_product_hash(org_id, sku) from products;
