import { describe, expect, it } from "vitest";
import { toFullInventoryListCsv } from "@/export/products-csv-live";

/** Trimmed shape of a real live GET /Product response, confirmed against the Spark Demo sandbox. */
const LIVE_PRODUCT = {
  SKU: "1 Test can",
  Name: "1 Test can",
  Category: "Test",
  Brand: null,
  Type: "Stock",
  CostingMethod: "FIFO",
  Length: 0,
  Width: 0,
  Height: 0,
  Weight: 0,
  UOM: "EACH",
  WeightUnits: "g",
  DimensionsUnits: "cm",
  Barcode: "",
  MinimumBeforeReorder: 0,
  ReorderQuantity: 0,
  PriceTier1: 10,
  AverageCost: 330,
  Description: "",
  Status: "Active",
  Sellable: true,
  BillOfMaterial: true,
  AutoAssembly: false,
  AutoDisassembly: false,
  QuantityToProduce: 1,
  DropShipMode: "No Drop Ship",
};

describe("toFullInventoryListCsv", () => {
  it("includes the exact InventoryList template header", () => {
    const csv = toFullInventoryListCsv([]);
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(
      '"ProductCode","Name","Category","Brand","Type","FixedAssetType","CostingMethod","Length","Width","Height","Weight","CartonLength","CartonWidth","CartonHeight","CartonInnerQuantity","CartonQuantity","CartonVolume","WeightUnits","DimensionUnits","Barcode","MinimumBeforeReorder","ReorderQuantity","DefaultLocation","LastSuppliedBy","SupplierProductCode","SupplierProductName","SupplierFixedPrice","PriceTier1","PriceTier2","PriceTier3","PriceTier4","PriceTier5","PriceTier6","PriceTier7","PriceTier8","PriceTier9","PriceTier10","AssemblyBOM","AutoAssemble","AutoDisassemble","DropShip","DropShipSupplier","AverageCost","DefaultUnitOfMeasure","InventoryAccount","RevenueAccount","ExpenseAccount","COGSAccount","ProductAttributeSet","AdditionalAttribute1","AdditionalAttribute2","AdditionalAttribute3","AdditionalAttribute4","AdditionalAttribute5","AdditionalAttribute6","AdditionalAttribute7","AdditionalAttribute8","AdditionalAttribute9","AdditionalAttribute10","DiscountName","ProductFamilySKU","ProductFamilyName","ProductFamilyOption1Name","ProductFamilyOption1Value","ProductFamilyOption2Name","ProductFamilyOption2Value","ProductFamilyOption3Name","ProductFamilyOption3Value","CommaDelimitedTags","StockLocator","PurchaseTaxRule","SaleTaxRule","Status","Description","ShortDescription","Sellable","PickZones","AlwaysShowQuantity","WarrantySetupName","InternalNote","ProductionBOM","MakeToOrderBom","QuantityToProduce","IsAccountingDimensionEnabled","DimensionAttribute1","DimensionAttribute2","DimensionAttribute3","DimensionAttribute4","DimensionAttribute5","DimensionAttribute6","DimensionAttribute7","DimensionAttribute8","DimensionAttribute9","DimensionAttribute10","HSCode","CountryOfOrigin"'
    );
  });

  it("maps a real live product record's confirmed fields", () => {
    const csv = toFullInventoryListCsv([LIVE_PRODUCT]);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toContain('"1 Test can"');
    expect(dataLine).toContain('"Test"');
    expect(dataLine).toContain('"Stock"');
    expect(dataLine).toContain('"FIFO"');
    expect(dataLine).toContain('"EACH"');
    expect(dataLine).toContain('"330"');
    expect(dataLine).toContain('"Yes"'); // BillOfMaterial -> AssemblyBOM
    expect(dataLine).toContain('"No"'); // AutoAssembly
    expect(dataLine).toContain('"No Drop Ship"');
  });

  it("leaves genuinely unconfirmed columns blank rather than guessing", () => {
    const csv = toFullInventoryListCsv([LIVE_PRODUCT]);
    const dataLine = csv.split("\r\n")[1];
    const cols = dataLine.split('","').map((c) => c.replace(/^"|"$/g, ""));
    expect(cols[5]).toBe(""); // FixedAssetType
    expect(cols[23]).toBe(""); // LastSuppliedBy
  });
});
