-- Full InventoryList field coverage. Brand/CostingMethod were each missed
-- for a while because only a subset of Cin7's real columns were modeled at
-- all — a value never captured on import can never be exported or pushed
-- either. This adds every remaining column so that gap can't recur
-- field-by-field. See src/model/products.ts for which of these are
-- "push-confirmed" (sent to Cin7, verified against a real live GET /Product
-- response) vs "capture-only" (stored for round-trip fidelity, held back
-- from the push until their live API field name is confirmed).
--
-- `tax_code` is replaced by separate `purchase_tax_rule`/`sale_tax_rule` —
-- it collapsed both CSV columns into one value (`SaleTaxRule ||
-- PurchaseTaxRule`), the same kind of lossy merge that turned Service
-- products into Stock before `cin7_type` was split out from `type`.

alter table products
  add column if not exists fixed_asset_type text,
  add column if not exists length numeric,
  add column if not exists width numeric,
  add column if not exists height numeric,
  add column if not exists weight numeric,
  add column if not exists carton_length numeric,
  add column if not exists carton_width numeric,
  add column if not exists carton_height numeric,
  add column if not exists carton_inner_quantity numeric,
  add column if not exists carton_quantity numeric,
  add column if not exists carton_volume numeric,
  add column if not exists weight_units text,
  add column if not exists dimension_units text,
  add column if not exists minimum_before_reorder numeric,
  add column if not exists reorder_quantity numeric,
  add column if not exists default_location text,
  add column if not exists last_supplied_by text,
  add column if not exists supplier_product_code text,
  add column if not exists supplier_product_name text,
  add column if not exists supplier_fixed_price numeric,
  add column if not exists auto_assemble boolean not null default false,
  add column if not exists auto_disassemble boolean not null default false,
  add column if not exists drop_ship text,
  add column if not exists drop_ship_supplier text,
  add column if not exists average_cost numeric,
  add column if not exists inventory_account text,
  add column if not exists revenue_account text,
  add column if not exists expense_account text,
  add column if not exists cogs_account text,
  add column if not exists product_attribute_set text,
  add column if not exists additional_attribute_1 text,
  add column if not exists additional_attribute_2 text,
  add column if not exists additional_attribute_3 text,
  add column if not exists additional_attribute_4 text,
  add column if not exists additional_attribute_5 text,
  add column if not exists additional_attribute_6 text,
  add column if not exists additional_attribute_7 text,
  add column if not exists additional_attribute_8 text,
  add column if not exists additional_attribute_9 text,
  add column if not exists additional_attribute_10 text,
  add column if not exists discount_name text,
  add column if not exists product_family_sku text,
  add column if not exists product_family_name text,
  add column if not exists product_family_option1_name text,
  add column if not exists product_family_option1_value text,
  add column if not exists product_family_option2_name text,
  add column if not exists product_family_option2_value text,
  add column if not exists product_family_option3_name text,
  add column if not exists product_family_option3_value text,
  add column if not exists comma_delimited_tags text,
  add column if not exists stock_locator text,
  add column if not exists purchase_tax_rule text,
  add column if not exists sale_tax_rule text,
  add column if not exists short_description text,
  add column if not exists sellable boolean not null default true,
  add column if not exists pick_zones text,
  add column if not exists always_show_quantity numeric,
  add column if not exists warranty_setup_name text,
  add column if not exists internal_note text,
  add column if not exists make_to_order_bom text,
  add column if not exists is_accounting_dimension_enabled text,
  add column if not exists dimension_attribute_1 text,
  add column if not exists dimension_attribute_2 text,
  add column if not exists dimension_attribute_3 text,
  add column if not exists dimension_attribute_4 text,
  add column if not exists dimension_attribute_5 text,
  add column if not exists dimension_attribute_6 text,
  add column if not exists dimension_attribute_7 text,
  add column if not exists dimension_attribute_8 text,
  add column if not exists dimension_attribute_9 text,
  add column if not exists dimension_attribute_10 text,
  add column if not exists hs_code text,
  add column if not exists country_of_origin text;

-- Backfill purchase_tax_rule/sale_tax_rule (and every new field above) from
-- each product's most recent committed products-import row, where the
-- original CSV data is still preserved verbatim in import_rows.raw — same
-- recovery approach used for cin7_type/brand, since none of this was ever
-- captured before this migration.
update products p set
  fixed_asset_type = nullif(sub.raw->>'FixedAssetType', ''),
  length = nullif(sub.raw->>'Length', '')::numeric,
  width = nullif(sub.raw->>'Width', '')::numeric,
  height = nullif(sub.raw->>'Height', '')::numeric,
  weight = nullif(sub.raw->>'Weight', '')::numeric,
  carton_length = nullif(sub.raw->>'CartonLength', '')::numeric,
  carton_width = nullif(sub.raw->>'CartonWidth', '')::numeric,
  carton_height = nullif(sub.raw->>'CartonHeight', '')::numeric,
  carton_inner_quantity = nullif(sub.raw->>'CartonInnerQuantity', '')::numeric,
  carton_quantity = nullif(sub.raw->>'CartonQuantity', '')::numeric,
  carton_volume = nullif(sub.raw->>'CartonVolume', '')::numeric,
  weight_units = nullif(sub.raw->>'WeightUnits', ''),
  dimension_units = nullif(sub.raw->>'DimensionUnits', ''),
  minimum_before_reorder = nullif(sub.raw->>'MinimumBeforeReorder', '')::numeric,
  reorder_quantity = nullif(sub.raw->>'ReorderQuantity', '')::numeric,
  default_location = nullif(sub.raw->>'DefaultLocation', ''),
  last_supplied_by = nullif(sub.raw->>'LastSuppliedBy', ''),
  supplier_product_code = nullif(sub.raw->>'SupplierProductCode', ''),
  supplier_product_name = nullif(sub.raw->>'SupplierProductName', ''),
  supplier_fixed_price = nullif(sub.raw->>'SupplierFixedPrice', '')::numeric,
  auto_assemble = upper(coalesce(sub.raw->>'AutoAssemble', '')) = 'YES',
  auto_disassemble = upper(coalesce(sub.raw->>'AutoDisassemble', '')) = 'YES',
  drop_ship = nullif(sub.raw->>'DropShip', ''),
  drop_ship_supplier = nullif(sub.raw->>'DropShipSupplier', ''),
  average_cost = nullif(sub.raw->>'AverageCost', '')::numeric,
  inventory_account = nullif(sub.raw->>'InventoryAccount', ''),
  revenue_account = nullif(sub.raw->>'RevenueAccount', ''),
  expense_account = nullif(sub.raw->>'ExpenseAccount', ''),
  cogs_account = nullif(sub.raw->>'COGSAccount', ''),
  product_attribute_set = nullif(sub.raw->>'ProductAttributeSet', ''),
  additional_attribute_1 = nullif(sub.raw->>'AdditionalAttribute1', ''),
  additional_attribute_2 = nullif(sub.raw->>'AdditionalAttribute2', ''),
  additional_attribute_3 = nullif(sub.raw->>'AdditionalAttribute3', ''),
  additional_attribute_4 = nullif(sub.raw->>'AdditionalAttribute4', ''),
  additional_attribute_5 = nullif(sub.raw->>'AdditionalAttribute5', ''),
  additional_attribute_6 = nullif(sub.raw->>'AdditionalAttribute6', ''),
  additional_attribute_7 = nullif(sub.raw->>'AdditionalAttribute7', ''),
  additional_attribute_8 = nullif(sub.raw->>'AdditionalAttribute8', ''),
  additional_attribute_9 = nullif(sub.raw->>'AdditionalAttribute9', ''),
  additional_attribute_10 = nullif(sub.raw->>'AdditionalAttribute10', ''),
  discount_name = nullif(sub.raw->>'DiscountName', ''),
  product_family_sku = nullif(sub.raw->>'ProductFamilySKU', ''),
  product_family_name = nullif(sub.raw->>'ProductFamilyName', ''),
  product_family_option1_name = nullif(sub.raw->>'ProductFamilyOption1Name', ''),
  product_family_option1_value = nullif(sub.raw->>'ProductFamilyOption1Value', ''),
  product_family_option2_name = nullif(sub.raw->>'ProductFamilyOption2Name', ''),
  product_family_option2_value = nullif(sub.raw->>'ProductFamilyOption2Value', ''),
  product_family_option3_name = nullif(sub.raw->>'ProductFamilyOption3Name', ''),
  product_family_option3_value = nullif(sub.raw->>'ProductFamilyOption3Value', ''),
  comma_delimited_tags = nullif(sub.raw->>'CommaDelimitedTags', ''),
  stock_locator = nullif(sub.raw->>'StockLocator', ''),
  purchase_tax_rule = nullif(sub.raw->>'PurchaseTaxRule', ''),
  sale_tax_rule = nullif(sub.raw->>'SaleTaxRule', ''),
  short_description = nullif(sub.raw->>'ShortDescription', ''),
  sellable = case when sub.raw->>'Sellable' is null or sub.raw->>'Sellable' = ''
                  then true else upper(sub.raw->>'Sellable') = 'YES' end,
  pick_zones = nullif(sub.raw->>'PickZones', ''),
  always_show_quantity = nullif(sub.raw->>'AlwaysShowQuantity', '')::numeric,
  warranty_setup_name = nullif(sub.raw->>'WarrantySetupName', ''),
  internal_note = nullif(sub.raw->>'InternalNote', ''),
  make_to_order_bom = nullif(sub.raw->>'MakeToOrderBom', ''),
  is_accounting_dimension_enabled = nullif(sub.raw->>'IsAccountingDimensionEnabled', ''),
  dimension_attribute_1 = nullif(sub.raw->>'DimensionAttribute1', ''),
  dimension_attribute_2 = nullif(sub.raw->>'DimensionAttribute2', ''),
  dimension_attribute_3 = nullif(sub.raw->>'DimensionAttribute3', ''),
  dimension_attribute_4 = nullif(sub.raw->>'DimensionAttribute4', ''),
  dimension_attribute_5 = nullif(sub.raw->>'DimensionAttribute5', ''),
  dimension_attribute_6 = nullif(sub.raw->>'DimensionAttribute6', ''),
  dimension_attribute_7 = nullif(sub.raw->>'DimensionAttribute7', ''),
  dimension_attribute_8 = nullif(sub.raw->>'DimensionAttribute8', ''),
  dimension_attribute_9 = nullif(sub.raw->>'DimensionAttribute9', ''),
  dimension_attribute_10 = nullif(sub.raw->>'DimensionAttribute10', ''),
  hs_code = nullif(sub.raw->>'HSCode', ''),
  country_of_origin = nullif(sub.raw->>'CountryOfOrigin', '')
from (
  select distinct on (b.org_id, ir.raw->>'ProductCode')
    b.org_id as org_id, ir.raw->>'ProductCode' as sku, ir.raw as raw
  from import_rows ir
  join import_batches b on b.id = ir.batch_id
  where b.kind = 'products' and ir.status = 'committed'
  order by b.org_id, ir.raw->>'ProductCode', b.created_at desc
) sub
where p.org_id = sub.org_id and p.sku = sub.sku;

-- Must drop the old trigger before dropping tax_code — it's referenced in
-- the trigger's "after update of ... tax_code" column list.
drop trigger if exists products_touch on products;
alter table products drop column if exists tax_code;

-- Recompute content_hash to include every push-confirmed field (not the
-- capture-only ones — those aren't pushed, so a change to them shouldn't
-- force a re-sync).
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
  auto_assemble, auto_disassemble, drop_ship,
  inventory_account, revenue_account, expense_account, cogs_account,
  product_attribute_set,
  additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4, additional_attribute_5,
  additional_attribute_6, additional_attribute_7, additional_attribute_8, additional_attribute_9, additional_attribute_10,
  discount_name, comma_delimited_tags, stock_locator, short_description, sellable, pick_zones,
  always_show_quantity, internal_note, hs_code, country_of_origin
  on products for each row execute function trg_product_touch();

-- Bump every existing product's hash so the newly-populated fields are
-- reflected and re-pushed on the next sync run.
select recompute_product_hash(org_id, sku) from products;
