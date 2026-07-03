-- Cin7 supports more product statuses than just Active/Inactive (e.g.
-- "Deprecated", used as the soft-delete mechanism for products — confirmed
-- by the client). Storing the raw CSV Status string (rather than deriving
-- Active/Inactive from a boolean) lets any status value flow through to
-- Cin7 unchanged. `active` stays as a simple filterable boolean derived from
-- status, for anything that just needs "is this usable".
alter table products add column if not exists status text not null default 'Active';

update products set status = case when active then 'Active' else 'Inactive' end
where status = 'Active';

-- Recompute content_hash to include the new status field going forward.
create or replace function recompute_product_hash(p_org_id uuid, p_sku text)
returns void language sql set search_path = public as $$
  update products p set
    content_hash = md5(
      coalesce(p.name,'') || '|' || coalesce(p.description,'') || '|' ||
      coalesce(p.category_code,'') || '|' || coalesce(p.uom_code,'') || '|' ||
      coalesce(p.barcode,'') || '|' || p.type::text || '|' ||
      coalesce(p.tax_code,'') || '|' || p.active::text || '|' || coalesce(p.status,'') || '|' ||
      coalesce((select string_agg(tier_code||':'||amount||':'||currency, ',' order by tier_code)
                from price_tiers where org_id = p.org_id and product_sku = p.sku), '') || '|' ||
      coalesce((select string_agg(component_sku||':'||quantity||':'||coalesce(cost_percentage,0), ',' order by component_sku)
                from assembly_bom_lines where org_id = p.org_id and product_sku = p.sku), '')
    ),
    updated_at = now()
  where p.org_id = p_org_id and p.sku = p_sku;
$$;

-- Bump every existing product's hash so the status field's inclusion is
-- reflected immediately rather than waiting for an unrelated future edit.
drop trigger if exists products_touch on products;
create trigger products_touch after insert or update of
  name, description, category_code, uom_code, barcode, type, tax_code, active, status
  on products for each row execute function trg_product_touch();
