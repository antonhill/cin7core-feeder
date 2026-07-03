-- Pin search_path on all trigger/helper functions (Supabase security advisor: function_search_path_mutable).

create or replace function recompute_product_hash(p_org_id uuid, p_sku text)
returns void language sql set search_path = public as $$
  update products p set
    content_hash = md5(
      coalesce(p.name,'') || '|' || coalesce(p.description,'') || '|' ||
      coalesce(p.category_code,'') || '|' || coalesce(p.uom_code,'') || '|' ||
      coalesce(p.barcode,'') || '|' || p.type::text || '|' ||
      coalesce(p.tax_code,'') || '|' || p.active::text || '|' ||
      coalesce((select string_agg(tier_code||':'||amount||':'||currency, ',' order by tier_code)
                from price_tiers where org_id = p.org_id and product_sku = p.sku), '') || '|' ||
      coalesce((select string_agg(component_sku||':'||quantity||':'||coalesce(cost_percentage,0), ',' order by component_sku)
                from assembly_bom_lines where org_id = p.org_id and product_sku = p.sku), '')
    ),
    updated_at = now()
  where p.org_id = p_org_id and p.sku = p_sku;
$$;

create or replace function trg_product_touch() returns trigger language plpgsql set search_path = public as $$
begin
  perform recompute_product_hash(coalesce(new.org_id, old.org_id), coalesce(new.sku, old.sku));
  return null;
end $$;

create or replace function trg_child_touch() returns trigger language plpgsql set search_path = public as $$
begin
  perform recompute_product_hash(coalesce(new.org_id, old.org_id), coalesce(new.product_sku, old.product_sku));
  return null;
end $$;

create or replace function recompute_production_bom_hash(p_org_id uuid, p_sku text, p_version text)
returns void language sql set search_path = public as $$
  update production_bom_versions v set
    content_hash = md5(
      coalesce(v.version_name,'') || '|' || v.version_default::text || '|' ||
      coalesce(v.quantity_to_produce,0)::text || '|' || coalesce(v.buffer_percent,0)::text || '|' ||
      coalesce((select string_agg(
                  o.operation_sequence||':'||o.operation_type||':'||coalesce(o.cycle_time,0)||':'||coalesce(o.work_centre_code,''),
                  ',' order by o.operation_sequence)
                from production_bom_operations o
                where o.org_id = v.org_id and o.product_sku = v.product_sku and o.version = v.version), '') || '|' ||
      coalesce((select string_agg(
                  i.operation_sequence||':'||i.item_type::text||':'||i.item_code||':'||i.quantity,
                  ',' order by i.operation_sequence, i.item_code)
                from production_bom_items i
                where i.org_id = v.org_id and i.product_sku = v.product_sku and i.version = v.version), '')
    ),
    updated_at = now()
  where v.org_id = p_org_id and v.product_sku = p_sku and v.version = p_version;
$$;

create or replace function trg_production_bom_version_touch() returns trigger language plpgsql set search_path = public as $$
begin
  perform recompute_production_bom_hash(coalesce(new.org_id, old.org_id), coalesce(new.product_sku, old.product_sku), coalesce(new.version, old.version));
  return null;
end $$;

create or replace function trg_production_bom_child_touch() returns trigger language plpgsql set search_path = public as $$
begin
  perform recompute_production_bom_hash(coalesce(new.org_id, old.org_id), coalesce(new.product_sku, old.product_sku), coalesce(new.version, old.version));
  return null;
end $$;
