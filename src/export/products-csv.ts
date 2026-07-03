import type { SupabaseClient } from "@supabase/supabase-js";
import { toCsv } from "@/export/csv-format";

const PRICE_TIER_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Matches Cin7's own InventoryList template column order exactly, except
 * `AssemblyBOM`/`ProductionBOM`/`QuantityToProduce` — those are derived from
 * the separate Assembly BOM / Production BOM tables and pushed as part of
 * that data, not stored as their own product fields (see cin7/products.ts,
 * cin7/assembly-bom.ts).
 */
const HEADER = [
  "ProductCode", "Name", "Category", "Brand", "Type", "FixedAssetType", "CostingMethod",
  "Length", "Width", "Height", "Weight",
  "CartonLength", "CartonWidth", "CartonHeight", "CartonInnerQuantity", "CartonQuantity", "CartonVolume",
  "WeightUnits", "DimensionUnits", "Barcode",
  "MinimumBeforeReorder", "ReorderQuantity", "DefaultLocation",
  "LastSuppliedBy", "SupplierProductCode", "SupplierProductName", "SupplierFixedPrice",
  ...PRICE_TIER_INDEXES.map((i) => `PriceTier${i}`),
  "AutoAssemble", "AutoDisassemble", "DropShip", "DropShipSupplier",
  "AverageCost", "DefaultUnitOfMeasure",
  "InventoryAccount", "RevenueAccount", "ExpenseAccount", "COGSAccount",
  "ProductAttributeSet",
  "AdditionalAttribute1", "AdditionalAttribute2", "AdditionalAttribute3", "AdditionalAttribute4", "AdditionalAttribute5",
  "AdditionalAttribute6", "AdditionalAttribute7", "AdditionalAttribute8", "AdditionalAttribute9", "AdditionalAttribute10",
  "DiscountName",
  "ProductFamilySKU", "ProductFamilyName",
  "ProductFamilyOption1Name", "ProductFamilyOption1Value",
  "ProductFamilyOption2Name", "ProductFamilyOption2Value",
  "ProductFamilyOption3Name", "ProductFamilyOption3Value",
  "CommaDelimitedTags", "StockLocator", "PurchaseTaxRule", "SaleTaxRule", "Status",
  "Description", "ShortDescription", "Sellable", "PickZones", "AlwaysShowQuantity",
  "WarrantySetupName", "InternalNote",
  "MakeToOrderBom", "IsAccountingDimensionEnabled",
  "DimensionAttribute1", "DimensionAttribute2", "DimensionAttribute3", "DimensionAttribute4", "DimensionAttribute5",
  "DimensionAttribute6", "DimensionAttribute7", "DimensionAttribute8", "DimensionAttribute9", "DimensionAttribute10",
  "HSCode", "CountryOfOrigin",
];

const SELECT_COLUMNS =
  "sku, name, category_code, brand, cin7_type, fixed_asset_type, costing_method, \
length, width, height, weight, carton_length, carton_width, carton_height, carton_inner_quantity, carton_quantity, carton_volume, \
weight_units, dimension_units, barcode, minimum_before_reorder, reorder_quantity, default_location, \
last_supplied_by, supplier_product_code, supplier_product_name, supplier_fixed_price, \
auto_assemble, auto_disassemble, drop_ship, drop_ship_supplier, average_cost, uom_code, \
inventory_account, revenue_account, expense_account, cogs_account, product_attribute_set, \
additional_attribute_1, additional_attribute_2, additional_attribute_3, additional_attribute_4, additional_attribute_5, \
additional_attribute_6, additional_attribute_7, additional_attribute_8, additional_attribute_9, additional_attribute_10, \
discount_name, product_family_sku, product_family_name, \
product_family_option1_name, product_family_option1_value, product_family_option2_name, product_family_option2_value, \
product_family_option3_name, product_family_option3_value, \
comma_delimited_tags, stock_locator, purchase_tax_rule, sale_tax_rule, status, description, short_description, \
sellable, pick_zones, always_show_quantity, warranty_setup_name, internal_note, \
make_to_order_bom, is_accounting_dimension_enabled, \
dimension_attribute_1, dimension_attribute_2, dimension_attribute_3, dimension_attribute_4, dimension_attribute_5, \
dimension_attribute_6, dimension_attribute_7, dimension_attribute_8, dimension_attribute_9, dimension_attribute_10, \
hs_code, country_of_origin";

function yesNo(value: boolean | null | undefined): string {
  return value ? "Yes" : "No";
}

/**
 * Exports the org's current canonical products (+ price tiers) in the same
 * column format as Cin7's InventoryList CSV template, so it can be edited
 * and reimported. This is the hub's own canonical data — the same source
 * pushed to every connected instance — not a live pull from a specific
 * Cin7 instance, so the result is identical regardless of which instance
 * you'd otherwise pick.
 */
export async function exportProductsCsv(db: SupabaseClient, orgId: string): Promise<string> {
  const { data: products, error } = await db
    .from("products")
    .select(SELECT_COLUMNS)
    .eq("org_id", orgId)
    .order("sku");
  if (error) throw new Error(`products: ${error.message}`);

  const { data: tiers, error: tierError } = await db
    .from("price_tiers")
    .select("product_sku, tier_code, amount")
    .eq("org_id", orgId);
  if (tierError) throw new Error(`price_tiers: ${tierError.message}`);

  const tiersBySku = new Map<string, Record<string, number>>();
  for (const t of tiers ?? []) {
    const bucket = tiersBySku.get(t.product_sku) ?? {};
    bucket[t.tier_code] = t.amount;
    tiersBySku.set(t.product_sku, bucket);
  }

  const rows = (products ?? []).map((p) => {
    const tierValues = tiersBySku.get(p.sku) ?? {};
    return [
      p.sku, p.name, p.category_code ?? "", p.brand ?? "", p.cin7_type ?? "Stock", p.fixed_asset_type ?? "",
      p.costing_method ?? "FIFO",
      p.length ?? "", p.width ?? "", p.height ?? "", p.weight ?? "",
      p.carton_length ?? "", p.carton_width ?? "", p.carton_height ?? "",
      p.carton_inner_quantity ?? "", p.carton_quantity ?? "", p.carton_volume ?? "",
      p.weight_units ?? "", p.dimension_units ?? "", p.barcode ?? "",
      p.minimum_before_reorder ?? "", p.reorder_quantity ?? "", p.default_location ?? "",
      p.last_supplied_by ?? "", p.supplier_product_code ?? "", p.supplier_product_name ?? "", p.supplier_fixed_price ?? "",
      ...PRICE_TIER_INDEXES.map((i) => tierValues[`Tier${i}`] ?? 0),
      yesNo(p.auto_assemble), yesNo(p.auto_disassemble), p.drop_ship ?? "", p.drop_ship_supplier ?? "",
      p.average_cost ?? "", p.uom_code ?? "",
      p.inventory_account ?? "", p.revenue_account ?? "", p.expense_account ?? "", p.cogs_account ?? "",
      p.product_attribute_set ?? "",
      p.additional_attribute_1 ?? "", p.additional_attribute_2 ?? "", p.additional_attribute_3 ?? "",
      p.additional_attribute_4 ?? "", p.additional_attribute_5 ?? "", p.additional_attribute_6 ?? "",
      p.additional_attribute_7 ?? "", p.additional_attribute_8 ?? "", p.additional_attribute_9 ?? "", p.additional_attribute_10 ?? "",
      p.discount_name ?? "",
      p.product_family_sku ?? "", p.product_family_name ?? "",
      p.product_family_option1_name ?? "", p.product_family_option1_value ?? "",
      p.product_family_option2_name ?? "", p.product_family_option2_value ?? "",
      p.product_family_option3_name ?? "", p.product_family_option3_value ?? "",
      p.comma_delimited_tags ?? "", p.stock_locator ?? "", p.purchase_tax_rule ?? "", p.sale_tax_rule ?? "",
      p.status ?? "Active", p.description ?? "", p.short_description ?? "",
      yesNo(p.sellable), p.pick_zones ?? "", p.always_show_quantity ?? "",
      p.warranty_setup_name ?? "", p.internal_note ?? "",
      p.make_to_order_bom ?? "", p.is_accounting_dimension_enabled ?? "",
      p.dimension_attribute_1 ?? "", p.dimension_attribute_2 ?? "", p.dimension_attribute_3 ?? "",
      p.dimension_attribute_4 ?? "", p.dimension_attribute_5 ?? "", p.dimension_attribute_6 ?? "",
      p.dimension_attribute_7 ?? "", p.dimension_attribute_8 ?? "", p.dimension_attribute_9 ?? "", p.dimension_attribute_10 ?? "",
      p.hs_code ?? "", p.country_of_origin ?? "",
    ];
  });

  return toCsv([HEADER, ...rows]);
}
