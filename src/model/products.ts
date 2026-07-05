import { z } from "zod";

/**
 * Mirrors every column of Cin7 Core's "InventoryList" CSV export template
 * (docs/cin7-templates/InventoryList_*.csv) so nothing is silently dropped
 * on import — Brand/CostingMethod/Type were each missed for a while because
 * only a subset of columns were modeled, and a value that's never captured
 * on import can never be exported or pushed either. `AssemblyBOM` and
 * `ProductionBOM` are deliberately excluded: both are purely
 * informational/derived in Cin7's own export (backed by the separate
 * Assembly BOM / Production BOM imports and tables), not real product data.
 */
export const productCsvRowSchema = z.object({
  ProductCode: z.string().trim().min(1, "ProductCode is required"),
  Name: z.string().trim().min(1, "Name is required"),
  Category: z.string().trim().optional().default(""),
  Brand: z.string().trim().optional().default(""),
  Type: z.string().trim().optional().default(""),
  FixedAssetType: z.string().trim().optional().default(""),
  CostingMethod: z.string().trim().optional().default(""),
  Length: z.coerce.number().optional(),
  Width: z.coerce.number().optional(),
  Height: z.coerce.number().optional(),
  Weight: z.coerce.number().optional(),
  CartonLength: z.coerce.number().optional(),
  CartonWidth: z.coerce.number().optional(),
  CartonHeight: z.coerce.number().optional(),
  CartonInnerQuantity: z.coerce.number().optional(),
  CartonQuantity: z.coerce.number().optional(),
  CartonVolume: z.coerce.number().optional(),
  WeightUnits: z.string().trim().optional().default(""),
  DimensionUnits: z.string().trim().optional().default(""),
  Barcode: z.string().trim().optional().default(""),
  MinimumBeforeReorder: z.coerce.number().optional(),
  ReorderQuantity: z.coerce.number().optional(),
  DefaultLocation: z.string().trim().optional().default(""),
  LastSuppliedBy: z.string().trim().optional().default(""),
  SupplierProductCode: z.string().trim().optional().default(""),
  SupplierProductName: z.string().trim().optional().default(""),
  SupplierFixedPrice: z.coerce.number().optional(),
  DefaultUnitOfMeasure: z.string().trim().optional().default(""),
  Status: z.string().trim().optional().default(""),
  Description: z.string().trim().optional().default(""),
  PurchaseTaxRule: z.string().trim().optional().default(""),
  SaleTaxRule: z.string().trim().optional().default(""),
  PriceTier1: z.coerce.number().optional(),
  PriceTier2: z.coerce.number().optional(),
  PriceTier3: z.coerce.number().optional(),
  PriceTier4: z.coerce.number().optional(),
  PriceTier5: z.coerce.number().optional(),
  PriceTier6: z.coerce.number().optional(),
  PriceTier7: z.coerce.number().optional(),
  PriceTier8: z.coerce.number().optional(),
  PriceTier9: z.coerce.number().optional(),
  PriceTier10: z.coerce.number().optional(),
  AutoAssemble: z.string().trim().optional().default(""),
  AutoDisassemble: z.string().trim().optional().default(""),
  DropShip: z.string().trim().optional().default(""),
  DropShipSupplier: z.string().trim().optional().default(""),
  AverageCost: z.coerce.number().optional(),
  InventoryAccount: z.string().trim().optional().default(""),
  RevenueAccount: z.string().trim().optional().default(""),
  ExpenseAccount: z.string().trim().optional().default(""),
  COGSAccount: z.string().trim().optional().default(""),
  ProductAttributeSet: z.string().trim().optional().default(""),
  AdditionalAttribute1: z.string().trim().optional().default(""),
  AdditionalAttribute2: z.string().trim().optional().default(""),
  AdditionalAttribute3: z.string().trim().optional().default(""),
  AdditionalAttribute4: z.string().trim().optional().default(""),
  AdditionalAttribute5: z.string().trim().optional().default(""),
  AdditionalAttribute6: z.string().trim().optional().default(""),
  AdditionalAttribute7: z.string().trim().optional().default(""),
  AdditionalAttribute8: z.string().trim().optional().default(""),
  AdditionalAttribute9: z.string().trim().optional().default(""),
  AdditionalAttribute10: z.string().trim().optional().default(""),
  DiscountName: z.string().trim().optional().default(""),
  ProductFamilySKU: z.string().trim().optional().default(""),
  ProductFamilyName: z.string().trim().optional().default(""),
  ProductFamilyOption1Name: z.string().trim().optional().default(""),
  ProductFamilyOption1Value: z.string().trim().optional().default(""),
  ProductFamilyOption2Name: z.string().trim().optional().default(""),
  ProductFamilyOption2Value: z.string().trim().optional().default(""),
  ProductFamilyOption3Name: z.string().trim().optional().default(""),
  ProductFamilyOption3Value: z.string().trim().optional().default(""),
  CommaDelimitedTags: z.string().trim().optional().default(""),
  StockLocator: z.string().trim().optional().default(""),
  ShortDescription: z.string().trim().optional().default(""),
  Sellable: z.string().trim().optional().default(""),
  PickZones: z.string().trim().optional().default(""),
  AlwaysShowQuantity: z.coerce.number().optional(),
  WarrantySetupName: z.string().trim().optional().default(""),
  InternalNote: z.string().trim().optional().default(""),
  MakeToOrderBom: z.string().trim().optional().default(""),
  IsAccountingDimensionEnabled: z.string().trim().optional().default(""),
  DimensionAttribute1: z.string().trim().optional().default(""),
  DimensionAttribute2: z.string().trim().optional().default(""),
  DimensionAttribute3: z.string().trim().optional().default(""),
  DimensionAttribute4: z.string().trim().optional().default(""),
  DimensionAttribute5: z.string().trim().optional().default(""),
  DimensionAttribute6: z.string().trim().optional().default(""),
  DimensionAttribute7: z.string().trim().optional().default(""),
  DimensionAttribute8: z.string().trim().optional().default(""),
  DimensionAttribute9: z.string().trim().optional().default(""),
  DimensionAttribute10: z.string().trim().optional().default(""),
  HSCode: z.string().trim().optional().default(""),
  CountryOfOrigin: z.string().trim().optional().default(""),
});

export type ProductCsvRow = z.infer<typeof productCsvRowSchema>;

/** Cin7 Core's own "Type" values -> our canonical product_type enum. */
const CIN7_TYPE_MAP: Record<string, "raw" | "component" | "assembly" | "finished" | "placeholder"> = {
  Stock: "component",
  Service: "component",
  "Non-Inventory": "raw",
  BillOfMaterials: "assembly",
};

export function mapCin7ProductType(cin7Type: string): "raw" | "component" | "assembly" | "finished" | "placeholder" {
  return CIN7_TYPE_MAP[cin7Type] ?? "component";
}

/**
 * Boolean convention for AutoAssemble/AutoDisassemble/Sellable. A real live
 * InventoryList export uses "Yes"/"No" (confirmed:
 * docs/cin7-templates/InventoryList_2026-07-03.csv), but Cin7's own field
 * docs describe "True"/"False" as the valid values for these same fields —
 * both are accepted here so a hand-filled CSV following Cin7's docs isn't
 * silently misparsed. Case-insensitive; anything else defaults to false.
 */
function parseYesNo(value: string): boolean {
  const v = value.trim().toUpperCase();
  return v === "YES" || v === "TRUE";
}

export interface CanonicalProduct {
  sku: string;
  name: string;
  description: string | null;
  category_code: string | null;
  brand: string | null;
  uom_code: string | null;
  barcode: string | null;
  type: "raw" | "component" | "assembly" | "finished" | "placeholder";
  active: boolean;
  /**
   * The raw CSV Status value (e.g. "Active", "Inactive", "Deprecated"),
   * pushed to Cin7 verbatim — Cin7 supports statuses beyond Active/Inactive
   * (Deprecated is the confirmed soft-delete mechanism for products), so
   * deriving just a boolean would lose that.
   */
  status: string;
  /**
   * Required by Cin7 on product create (POST /Product fails with "Required
   * attribute 'CostingMethod' not provided" otherwise) — confirmed live.
   * Every sample row in Cin7's own InventoryList export uses "FIFO".
   */
  costing_method: string;
  /**
   * The raw CSV Type value (e.g. "Stock", "Service", "Non-Inventory"),
   * pushed to Cin7 verbatim — the `type` field above is lossy (Stock and
   * Service both collapse to "component"), which silently turned Service
   * products into Stock on every push. Same pattern as `status` vs `active`.
   */
  cin7_type: string;

  // --- Below: added in the full-field-coverage pass. Fields marked
  // "push-confirmed" have a verified Cin7 JSON field name (from a real live
  // GET /Product response) and are sent on every push. Fields marked
  // "capture-only" are stored so a re-export round-trips them faithfully,
  // but are NOT yet sent to Cin7 — their live JSON field name (or even
  // whether Cin7's API accepts them at all) isn't confirmed, and guessing
  // has repeatedly cost a round-trip in this project (Work Centres,
  // Production BOM fields). Confirm via a live 400/response before wiring
  // any of these into the push payload.

  fixed_asset_type: string | null; // capture-only
  length: number | null; // push-confirmed
  width: number | null; // push-confirmed
  height: number | null; // push-confirmed
  weight: number | null; // push-confirmed
  carton_length: number | null; // push-confirmed
  carton_width: number | null; // push-confirmed
  carton_height: number | null; // push-confirmed
  carton_inner_quantity: number | null; // push-confirmed
  carton_quantity: number | null; // push-confirmed
  carton_volume: number | null; // capture-only
  weight_units: string | null; // push-confirmed
  dimension_units: string | null; // push-confirmed (Cin7 JSON field is "DimensionsUnits")
  minimum_before_reorder: number | null; // push-confirmed
  reorder_quantity: number | null; // push-confirmed
  default_location: string | null; // push-confirmed
  // push-confirmed (2026-07-03) — Cin7's Product resource carries a nested
  // `Suppliers` array, sent in the same POST/PUT payload as everything
  // else; an item is referenced by SupplierName (not a pre-resolved GUID —
  // Cin7 accepts either). The CSV's flat single-supplier-per-row columns
  // map onto that one array item: `last_supplied_by` is the supplier name
  // itself (there's no separate "is this the default supplier" field in
  // Cin7's model — the CSV format just assumes one supplier per row).
  // Two of Cin7's real field names differ from the CSV column names:
  // SupplierProductCode -> SupplierInventoryCode, SupplierFixedPrice ->
  // FixedCost. See toCin7ProductPayload in cin7/products.ts.
  last_supplied_by: string | null;
  supplier_product_code: string | null;
  supplier_product_name: string | null;
  supplier_fixed_price: number | null;
  auto_assemble: boolean; // push-confirmed (Cin7 JSON field is "AutoAssembly")
  auto_disassemble: boolean; // push-confirmed (Cin7 JSON field is "AutoDisassembly")
  drop_ship: string | null; // push-confirmed (Cin7 JSON field is "DropShipMode"; a text enum like "No Drop Ship", not boolean)
  drop_ship_supplier: string | null; // capture-only (references a Supplier)
  average_cost: number | null; // capture-only — Cin7 computes this from costing method + purchase history; not something we should push
  inventory_account: string | null; // push-confirmed (references an existing Chart of Accounts code — never auto-created, see docs/cin7-api-findings.md §5)
  revenue_account: string | null; // push-confirmed
  expense_account: string | null; // push-confirmed
  cogs_account: string | null; // push-confirmed
  product_attribute_set: string | null; // push-confirmed (Cin7 JSON field is "AttributeSet")
  additional_attribute_1: string | null; // push-confirmed
  additional_attribute_2: string | null; // push-confirmed
  additional_attribute_3: string | null; // push-confirmed
  additional_attribute_4: string | null; // push-confirmed
  additional_attribute_5: string | null; // push-confirmed
  additional_attribute_6: string | null; // push-confirmed
  additional_attribute_7: string | null; // push-confirmed
  additional_attribute_8: string | null; // push-confirmed
  additional_attribute_9: string | null; // push-confirmed
  additional_attribute_10: string | null; // push-confirmed
  discount_name: string | null; // push-confirmed (Cin7 JSON field is "DiscountRule")
  product_family_sku: string | null; // capture-only (product variants — a structurally different feature)
  product_family_name: string | null; // capture-only
  product_family_option1_name: string | null; // capture-only
  product_family_option1_value: string | null; // capture-only
  product_family_option2_name: string | null; // capture-only
  product_family_option2_value: string | null; // capture-only
  product_family_option3_name: string | null; // capture-only
  product_family_option3_value: string | null; // capture-only
  comma_delimited_tags: string | null; // push-confirmed (Cin7 JSON field is "Tags")
  stock_locator: string | null; // push-confirmed
  purchase_tax_rule: string | null; // push-confirmed — replaces the old lossy `tax_code` (which collapsed Purchase/Sale into one value)
  sale_tax_rule: string | null; // push-confirmed
  short_description: string | null; // push-confirmed
  sellable: boolean; // push-confirmed
  pick_zones: string | null; // push-confirmed
  always_show_quantity: number | null; // push-confirmed
  warranty_setup_name: string | null; // capture-only — no CRUD endpoint found for this at all (researched); unclear if/how Cin7's API accepts it
  internal_note: string | null; // push-confirmed
  make_to_order_bom: string | null; // capture-only (raw Yes/No text; not confirmed as a real product-level API field)
  is_accounting_dimension_enabled: string | null; // capture-only
  dimension_attribute_1: string | null; // capture-only
  dimension_attribute_2: string | null; // capture-only
  dimension_attribute_3: string | null; // capture-only
  dimension_attribute_4: string | null; // capture-only
  dimension_attribute_5: string | null; // capture-only
  dimension_attribute_6: string | null; // capture-only
  dimension_attribute_7: string | null; // capture-only
  dimension_attribute_8: string | null; // capture-only
  dimension_attribute_9: string | null; // capture-only
  dimension_attribute_10: string | null; // capture-only
  hs_code: string | null; // push-confirmed
  country_of_origin: string | null; // push-confirmed
}

export interface CanonicalPriceTier {
  product_sku: string;
  tier_code: string;
  amount: number;
}

const PRICE_TIER_COLUMNS = [
  "PriceTier1", "PriceTier2", "PriceTier3", "PriceTier4", "PriceTier5",
  "PriceTier6", "PriceTier7", "PriceTier8", "PriceTier9", "PriceTier10",
] as const;

export function toCanonicalProduct(row: ProductCsvRow): CanonicalProduct {
  return {
    sku: row.ProductCode,
    name: row.Name,
    description: row.Description || null,
    category_code: row.Category || null,
    brand: row.Brand || null,
    uom_code: row.DefaultUnitOfMeasure || null,
    barcode: row.Barcode || null,
    type: mapCin7ProductType(row.Type),
    active: row.Status ? row.Status.toUpperCase() === "ACTIVE" : true,
    status: row.Status || "Active",
    costing_method: row.CostingMethod || "FIFO",
    cin7_type: row.Type || "Stock",

    fixed_asset_type: row.FixedAssetType || null,
    length: row.Length ?? null,
    width: row.Width ?? null,
    height: row.Height ?? null,
    weight: row.Weight ?? null,
    carton_length: row.CartonLength ?? null,
    carton_width: row.CartonWidth ?? null,
    carton_height: row.CartonHeight ?? null,
    carton_inner_quantity: row.CartonInnerQuantity ?? null,
    carton_quantity: row.CartonQuantity ?? null,
    carton_volume: row.CartonVolume ?? null,
    weight_units: row.WeightUnits || null,
    dimension_units: row.DimensionUnits || null,
    minimum_before_reorder: row.MinimumBeforeReorder ?? null,
    reorder_quantity: row.ReorderQuantity ?? null,
    default_location: row.DefaultLocation || null,
    last_supplied_by: row.LastSuppliedBy || null,
    supplier_product_code: row.SupplierProductCode || null,
    supplier_product_name: row.SupplierProductName || null,
    supplier_fixed_price: row.SupplierFixedPrice ?? null,
    auto_assemble: parseYesNo(row.AutoAssemble),
    auto_disassemble: parseYesNo(row.AutoDisassemble),
    drop_ship: row.DropShip || null,
    drop_ship_supplier: row.DropShipSupplier || null,
    average_cost: row.AverageCost ?? null,
    inventory_account: row.InventoryAccount || null,
    revenue_account: row.RevenueAccount || null,
    expense_account: row.ExpenseAccount || null,
    cogs_account: row.COGSAccount || null,
    product_attribute_set: row.ProductAttributeSet || null,
    additional_attribute_1: row.AdditionalAttribute1 || null,
    additional_attribute_2: row.AdditionalAttribute2 || null,
    additional_attribute_3: row.AdditionalAttribute3 || null,
    additional_attribute_4: row.AdditionalAttribute4 || null,
    additional_attribute_5: row.AdditionalAttribute5 || null,
    additional_attribute_6: row.AdditionalAttribute6 || null,
    additional_attribute_7: row.AdditionalAttribute7 || null,
    additional_attribute_8: row.AdditionalAttribute8 || null,
    additional_attribute_9: row.AdditionalAttribute9 || null,
    additional_attribute_10: row.AdditionalAttribute10 || null,
    discount_name: row.DiscountName || null,
    product_family_sku: row.ProductFamilySKU || null,
    product_family_name: row.ProductFamilyName || null,
    product_family_option1_name: row.ProductFamilyOption1Name || null,
    product_family_option1_value: row.ProductFamilyOption1Value || null,
    product_family_option2_name: row.ProductFamilyOption2Name || null,
    product_family_option2_value: row.ProductFamilyOption2Value || null,
    product_family_option3_name: row.ProductFamilyOption3Name || null,
    product_family_option3_value: row.ProductFamilyOption3Value || null,
    comma_delimited_tags: row.CommaDelimitedTags || null,
    stock_locator: row.StockLocator || null,
    purchase_tax_rule: row.PurchaseTaxRule || null,
    sale_tax_rule: row.SaleTaxRule || null,
    short_description: row.ShortDescription || null,
    sellable: row.Sellable ? parseYesNo(row.Sellable) : true,
    pick_zones: row.PickZones || null,
    always_show_quantity: row.AlwaysShowQuantity ?? null,
    warranty_setup_name: row.WarrantySetupName || null,
    internal_note: row.InternalNote || null,
    make_to_order_bom: row.MakeToOrderBom || null,
    is_accounting_dimension_enabled: row.IsAccountingDimensionEnabled || null,
    dimension_attribute_1: row.DimensionAttribute1 || null,
    dimension_attribute_2: row.DimensionAttribute2 || null,
    dimension_attribute_3: row.DimensionAttribute3 || null,
    dimension_attribute_4: row.DimensionAttribute4 || null,
    dimension_attribute_5: row.DimensionAttribute5 || null,
    dimension_attribute_6: row.DimensionAttribute6 || null,
    dimension_attribute_7: row.DimensionAttribute7 || null,
    dimension_attribute_8: row.DimensionAttribute8 || null,
    dimension_attribute_9: row.DimensionAttribute9 || null,
    dimension_attribute_10: row.DimensionAttribute10 || null,
    hs_code: row.HSCode || null,
    country_of_origin: row.CountryOfOrigin || null,
  };
}

export function toCanonicalPriceTiers(row: ProductCsvRow): CanonicalPriceTier[] {
  return PRICE_TIER_COLUMNS
    .map((col, i) => ({ tier_code: `Tier${i + 1}`, amount: row[col] }))
    .filter((t): t is { tier_code: string; amount: number } => typeof t.amount === "number" && t.amount > 0)
    .map((t) => ({ product_sku: row.ProductCode, tier_code: t.tier_code, amount: t.amount }));
}
