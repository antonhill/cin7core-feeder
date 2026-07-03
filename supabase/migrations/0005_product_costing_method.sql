-- Cin7 requires CostingMethod on product create (POST /Product) — confirmed
-- live: pushing a brand-new SKU without it fails with "Required attribute
-- 'CostingMethod' not provided" (existing products update fine without it,
-- so this was only surfaced by create traffic). Cin7's own InventoryList
-- export always populates this (observed value: "FIFO" for every sample
-- row), so default to that.
alter table products add column if not exists costing_method text not null default 'FIFO';

-- Recompute content_hash to include costing_method going forward.
create or replace function recompute_product_hash(p_org_id uuid, p_sku text)
returns void language sql set search_path = public as $$
  update products p set
    content_hash = md5(
      coalesce(p.name,'') || '|' || coalesce(p.description,'') || '|' ||
      coalesce(p.category_code,'') || '|' || coalesce(p.uom_code,'') || '|' ||
      coalesce(p.barcode,'') || '|' || p.type::text || '|' ||
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

-- Bump every existing product's hash so the field is reflected immediately,
-- and force a re-push so already-synced products (created before this fix,
-- likely still missing CostingMethod on Cin7's side for any that failed) get
-- corrected on the next sync run rather than being skipped as "unchanged".
drop trigger if exists products_touch on products;
create trigger products_touch after insert or update of
  name, description, category_code, uom_code, barcode, type, tax_code, active, status, costing_method
  on products for each row execute function trg_product_touch();

select recompute_product_hash(org_id, sku) from products;
