import { toCsv } from "@/export/csv-format";

/**
 * Full InventoryList template header, matching Cin7's own export exactly
 * (docs/cin7-templates/InventoryList_*.csv) — unlike the hub's own canonical
 * export (products-csv.ts, ~10 columns we actually store), this is meant to
 * round-trip through Cin7's own bulk-import UI unchanged.
 */
const HEADER = [
  "ProductCode", "Name", "Category", "Brand", "Type", "FixedAssetType", "CostingMethod",
  "Length", "Width", "Height", "Weight",
  "CartonLength", "CartonWidth", "CartonHeight", "CartonInnerQuantity", "CartonQuantity", "CartonVolume",
  "WeightUnits", "DimensionUnits", "Barcode",
  "MinimumBeforeReorder", "ReorderQuantity", "DefaultLocation",
  "LastSuppliedBy", "SupplierProductCode", "SupplierProductName", "SupplierFixedPrice",
  "PriceTier1", "PriceTier2", "PriceTier3", "PriceTier4", "PriceTier5",
  "PriceTier6", "PriceTier7", "PriceTier8", "PriceTier9", "PriceTier10",
  "AssemblyBOM", "AutoAssemble", "AutoDisassemble", "DropShip", "DropShipSupplier",
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
  "ProductionBOM", "MakeToOrderBom", "QuantityToProduce", "IsAccountingDimensionEnabled",
  "DimensionAttribute1", "DimensionAttribute2", "DimensionAttribute3", "DimensionAttribute4", "DimensionAttribute5",
  "DimensionAttribute6", "DimensionAttribute7", "DimensionAttribute8", "DimensionAttribute9", "DimensionAttribute10",
  "HSCode", "CountryOfOrigin",
];

/** Cin7's own export uses "Yes"/"No" text for boolean columns (confirmed against real sample rows). */
function yesNo(value: unknown): string {
  return value ? "Yes" : "No";
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

const PRICE_TIER_INDEXES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

/**
 * Maps a raw Cin7 GET /Product record (see fetchAllProductsWithBom) to a full
 * InventoryList CSV row. Best-effort: a handful of columns (Supplier*,
 * ProductFamily*, DropShipSupplier, CartonVolume, FixedAssetType,
 * MakeToOrderBom, DimensionAttribute1-10, IsAccountingDimensionEnabled) have
 * no confirmed field on this endpoint's response (either genuinely absent,
 * e.g. empty Suppliers[] in the live sample, or would need a separate call
 * per product) — left blank rather than guessed.
 */
function toRow(p: Record<string, unknown>): (string | number)[] {
  const priceTiers = PRICE_TIER_INDEXES.map((i) => str(p[`PriceTier${i}`] ?? 0));
  return [
    str(p.SKU), str(p.Name), str(p.Category), str(p.Brand), str(p.Type), "", str(p.CostingMethod),
    str(p.Length ?? 0), str(p.Width ?? 0), str(p.Height ?? 0), str(p.Weight ?? 0),
    str(p.CartonLength ?? 0), str(p.CartonWidth ?? 0), str(p.CartonHeight ?? 0),
    str(p.CartonInnerQuantity ?? 0), str(p.CartonQuantity ?? 0), "",
    str(p.WeightUnits), str(p.DimensionsUnits), str(p.Barcode),
    str(p.MinimumBeforeReorder ?? 0), str(p.ReorderQuantity ?? 0), str(p.DefaultLocation),
    "", "", "", "",
    ...priceTiers,
    yesNo(p.BillOfMaterial), yesNo(p.AutoAssembly), yesNo(p.AutoDisassembly),
    str(p.DropShipMode), "",
    str(p.AverageCost ?? 0), str(p.UOM),
    str(p.InventoryAccount), str(p.RevenueAccount), str(p.ExpenseAccount), str(p.COGSAccount),
    str(p.AttributeSet),
    str(p.AdditionalAttribute1), str(p.AdditionalAttribute2), str(p.AdditionalAttribute3),
    str(p.AdditionalAttribute4), str(p.AdditionalAttribute5), str(p.AdditionalAttribute6),
    str(p.AdditionalAttribute7), str(p.AdditionalAttribute8), str(p.AdditionalAttribute9), str(p.AdditionalAttribute10),
    str(p.DiscountRule),
    "", "", "", "", "", "", "", "",
    str(p.Tags), str(p.StockLocator), str(p.PurchaseTaxRule), str(p.SaleTaxRule), str(p.Status),
    str(p.Description), str(p.ShortDescription), yesNo(p.Sellable), str(p.PickZones), str(p.AlwaysShowQuantity ?? 0),
    str(p.WarrantyName), str(p.InternalNote),
    "", "", str(p.QuantityToProduce ?? ""), "",
    "", "", "", "", "", "", "", "", "", "",
    str(p.HSCode), str(p.CountryOfOrigin),
  ];
}

/** Full-fidelity export of every product currently live in a chosen Cin7 instance. */
export function toFullInventoryListCsv(products: Record<string, unknown>[]): string {
  return toCsv([HEADER, ...products.map(toRow)]);
}
