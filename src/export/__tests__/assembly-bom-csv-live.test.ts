import { describe, expect, it } from "vitest";
import { toFullAssemblyBomCsv } from "@/export/assembly-bom-csv-live";

/** Trimmed shape of a real live GET /Product response with a BOM, confirmed against the Spark Demo sandbox. */
const LIVE_BOM_PRODUCT = {
  SKU: "1 Test can",
  Name: "1 Test can",
  BillOfMaterial: true,
  BillOfMaterialsProducts: [
    {
      ComponentProductID: "4c28637b-02f0-4232-945d-a97cd54cdbee",
      ProductCode: "F12-CRS-SWPC-DEMO",
      Name: "1/2in Cross Std White PC",
      Quantity: 2,
      WastagePercent: 0,
      WastageQuantity: 0,
      CostPercentage: 0,
    },
  ],
  BillOfMaterialsServices: [
    {
      ComponentProductID: "f5aa9b93-8c95-4208-bbb0-297b6f94131d",
      Name: "Labour",
      Quantity: 1,
      ExpenseAccount: "260",
      PriceTier: 1,
    },
  ],
};

describe("toFullAssemblyBomCsv", () => {
  it("includes the exact AssemblyBOM template header", () => {
    const csv = toFullAssemblyBomCsv([]);
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(
      '"Action","ProductSKU","ProductName","ComponentSKU","ComponentName","Quantity","WastageQuantity_ForStockComponentOnly","WastagePercent_ForStockComponentOnly","CostPercentage_ForStockComponentOnly","PriceTier_ForServiceComponentOnly","ExpenseAccount_ForServiceComponentOnly","EstimatedUnitCost"'
    );
  });

  it("emits one row per stock component and one per service component", () => {
    const csv = toFullAssemblyBomCsv([LIVE_BOM_PRODUCT]);
    const lines = csv.trim().split("\r\n").slice(1);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"F12-CRS-SWPC-DEMO"');
    expect(lines[0]).toContain('"2"');
    expect(lines[1]).toContain('"Labour"');
    expect(lines[1]).toContain('"260"');
  });

  it("skips products with no BOM lines", () => {
    const csv = toFullAssemblyBomCsv([{ SKU: "PLAIN", Name: "Plain product" }]);
    const lines = csv.trim().split("\r\n");
    expect(lines).toHaveLength(1); // header only
  });
});
