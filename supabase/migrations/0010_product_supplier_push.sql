-- Supplier fields (last_supplied_by/supplier_product_code/
-- supplier_product_name/supplier_fixed_price) move from capture-only to
-- push-confirmed now that Cin7's Suppliers[] array shape is confirmed (see
-- docs/cin7-api-findings.md) — include them in content_hash so a change
-- actually triggers a re-sync, matching every other push-confirmed field.
create or replace function recompute_product_hash(p_org_id uuid, p_sku text)
returns void language sql set search_path = public as $$
  update products p set
    content_hash = md5(
      coalesce(p.name,'') || '|' || coalesce(p.description,'') || '|' ||
      coalesce(p.category_code,'') || '|' || coalesce(p.brand,'') || '|' ||
      coalesce(p.uom_code,'') || '|' ||
      coalesce(p.barcode,'') || '|' || coalesce(p.cin7_type,'') || '|' ||
      coalesce(p.purchase_tax_rule,'') || '|' || coalesce(p.sale_tax_rule,'') || '|' ||
      p.active::text || '|' || coalesce(p.status,'') || '|' ||
      coalesce(p.costing_method,'') || '|' ||
      coalesce(p.length::text,'') || '|' || coalesce(p.width::text,'') || '|' ||
      coalesce(p.height::text,'') || '|' || coalesce(p.weight::text,'') || '|' ||
      coalesce(p.carton_length::text,'') || '|' || coalesce(p.carton_width::text,'') || '|' ||
      coalesce(p.carton_height::text,'') || '|' || coalesce(p.carton_inner_quantity::text,'') || '|' ||
      coalesce(p.carton_quantity::text,'') || '|' ||
      coalesce(p.weight_units,'') || '|' || coalesce(p.dimension_units,'') || '|' ||
      coalesce(p.minimum_before_reorder::text,'') || '|' || coalesce(p.reorder_quantity::text,'') || '|' ||
      coalesce(p.default_location,'') || '|' ||
      coalesce(p.last_supplied_by,'') || '|' || coalesce(p.supplier_product_code,'') || '|' ||
      coalesce(p.supplier_product_name,'') || '|' || coalesce(p.supplier_fixed_price::text,'') || '|' ||
      p.auto_assemble::text || '|' || p.auto_disassemble::text || '|' ||
      coalesce(p.drop_ship,'') || '|' ||
      coalesce(p.inventory_account,'') || '|' || coalesce(p.revenue_account,'') || '|' ||
      coalesce(p.expense_account,'') || '|' || coalesce(p.cogs_account,'') || '|' ||
      coalesce(p.product_attribute_set,'') || '|' ||
      coalesce(p.additional_attribute_1,'') || '|' || coalesce(p.additional_attribute_2,'') || '|' ||
      coalesce(p.additional_attribute_3,'') || '|' || coalesce(p.additional_attribute_4,'') || '|' ||
      coalesce(p.additional_attribute_5,'') || '|' || coalesce(p.additional_attribute_6,'') || '|' ||
      coalesce(p.additional_attribute_7,'') || '|' || coalesce(p.additional_attribute_8,'') || '|' ||
      coalesce(p.additional_attribute_9,'') || '|' || coalesce(p.additional_attribute_10,'') || '|' ||
      coalesce(p.discount_name,'') || '|' || coalesce(p.comma_delimited_tags,'') || '|' ||
      coalesce(p.stock_locator,'') || '|' || coalesce(p.short_description,'') || '|' ||
      p.sellable::text || '|' || coalesce(p.pick_zones,'') || '|' ||
      coalesce(p.always_show_quantity::text,'') || '|' || coalesce(p.internal_note,'') || '|' ||
      coalesce(p.hs_code,'') || '|' || coalesce(p.country_of_origin,'') || '|' ||
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
  name, description, category_code, brand, uom_code, barcode, type, cin7_type,
  purchase_tax_rule, sale_tax_rule, active, status, costing_method,
  length, width, height, weight, carton_length, carton_width, carton_height,
  carton_inner_quantity, carton_quantity, weight_units, dimension_units,
  minimum_before_reorder, reorder_quantity, default_location,
  last_supplied_by, supplier_product_code, supplier_product_name, supplier_fixed_price,
  auto_assemble, auto_disassemble, drop_ship,
  inventory_account, revenue_account, expense_account, cogs_account,
  product_attribute_set,
  additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4, additional_attribute_5,
  additional_attribute_6, additional_attribute_7, additional_attribute_8, additional_attribute_9, additional_attribute_10,
  discount_name, comma_delimited_tags, stock_locator, short_description, sellable, pick_zones,
  always_show_quantity, internal_note, hs_code, country_of_origin
  on products for each row execute function trg_product_touch();

-- Force a re-sync so products with supplier data already imported (but
-- never pushed, since Suppliers[] wasn't wired up until now) get it sent on
-- the next sync run — a hash recompute alone won't bump anything for
-- products whose supplier fields haven't changed since import. Scoped by
-- (org_id, sku) together, not sku alone, since sku is only unique per org.
update sync_state ss set synced_hash = null
from products p
where ss.org_id = p.org_id and ss.sku = p.sku
  and (p.last_supplied_by is not null
    or p.supplier_product_code is not null
    or p.supplier_product_name is not null
    or p.supplier_fixed_price is not null);

select recompute_product_hash(org_id, sku) from products;
