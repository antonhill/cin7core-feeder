import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { exportProductsCsv } from "@/export/products-csv";

/** Minimal in-memory stand-in for .select().eq().order() chains. */
function createFakeDb(tables: Record<string, Record<string, unknown>[]>) {
  function builder(table: string) {
    const filters: [string, unknown][] = [];
    const api = {
      select: () => api,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return api;
      },
      order: () => api,
      then: (resolve: (v: { data: unknown[]; error: null }) => void) => {
        const rows = tables[table] ?? [];
        resolve({ data: rows.filter((r) => filters.every(([c, v]) => r[c] === v)), error: null });
      },
    };
    return api;
  }
  return { from: builder } as unknown as SupabaseClient;
}

describe("exportProductsCsv", () => {
  it("includes the exact InventoryList template header", async () => {
    const db = createFakeDb({ products: [], price_tiers: [] });
    const csv = await exportProductsCsv(db, "org1");
    const firstLine = csv.split("\r\n")[0];
    expect(firstLine).toBe(
      '"ProductCode","Name","Category","Brand","Type","FixedAssetType","CostingMethod","Length","Width","Height","Weight","CartonLength","CartonWidth","CartonHeight","CartonInnerQuantity","CartonQuantity","CartonVolume","WeightUnits","DimensionUnits","Barcode","MinimumBeforeReorder","ReorderQuantity","DefaultLocation","LastSuppliedBy","SupplierProductCode","SupplierProductName","SupplierFixedPrice","PriceTier1","PriceTier2","PriceTier3","PriceTier4","PriceTier5","PriceTier6","PriceTier7","PriceTier8","PriceTier9","PriceTier10","AutoAssemble","AutoDisassemble","DropShip","DropShipSupplier","AverageCost","DefaultUnitOfMeasure","InventoryAccount","RevenueAccount","ExpenseAccount","COGSAccount","ProductAttributeSet","AdditionalAttribute1","AdditionalAttribute2","AdditionalAttribute3","AdditionalAttribute4","AdditionalAttribute5","AdditionalAttribute6","AdditionalAttribute7","AdditionalAttribute8","AdditionalAttribute9","AdditionalAttribute10","DiscountName","ProductFamilySKU","ProductFamilyName","ProductFamilyOption1Name","ProductFamilyOption1Value","ProductFamilyOption2Name","ProductFamilyOption2Value","ProductFamilyOption3Name","ProductFamilyOption3Value","CommaDelimitedTags","StockLocator","PurchaseTaxRule","SaleTaxRule","Status","Description","ShortDescription","Sellable","PickZones","AlwaysShowQuantity","WarrantySetupName","InternalNote","MakeToOrderBom","IsAccountingDimensionEnabled","DimensionAttribute1","DimensionAttribute2","DimensionAttribute3","DimensionAttribute4","DimensionAttribute5","DimensionAttribute6","DimensionAttribute7","DimensionAttribute8","DimensionAttribute9","DimensionAttribute10","HSCode","CountryOfOrigin"'
    );
  });

  /** Splits a quoted CSV data line back into its raw field values (test data never contains embedded commas). */
  function parseDataLine(line: string): string[] {
    return line.slice(1, -1).split('","');
  }

  it("maps a product row and merges in its price tiers by index", async () => {
    const db = createFakeDb({
      products: [
        {
          org_id: "org1",
          sku: "SKU1",
          name: "Widget",
          category_code: "Widgets",
          brand: "Acme",
          uom_code: "Item",
          barcode: "12345",
          cin7_type: "Service",
          purchase_tax_rule: "Purchases 15%",
          sale_tax_rule: "Sales 15%",
          status: "Active",
          description: "A widget",
          costing_method: "FIFO",
          weight: 1.5,
          auto_assemble: true,
          sellable: true,
        },
      ],
      price_tiers: [
        { org_id: "org1", product_sku: "SKU1", tier_code: "Tier1", amount: 100 },
        { org_id: "org1", product_sku: "SKU1", tier_code: "Tier3", amount: 90 },
      ],
    });

    const csv = await exportProductsCsv(db, "org1");
    const fields = parseDataLine(csv.split("\r\n")[1]);

    expect(fields[0]).toBe("SKU1");
    expect(fields[1]).toBe("Widget");
    expect(fields[4]).toBe("Service"); // Type — verbatim, not reverse-mapped from an internal category
    expect(fields[3]).toBe("Acme"); // Brand
    expect(fields[10]).toBe("1.5"); // Weight
    expect(fields[27]).toBe("100"); // PriceTier1
    expect(fields[29]).toBe("90"); // PriceTier3
    expect(fields[37]).toBe("Yes"); // AutoAssemble
    expect(fields[69]).toBe("Purchases 15%"); // PurchaseTaxRule
    expect(fields[70]).toBe("Sales 15%"); // SaleTaxRule
    expect(fields[74]).toBe("Yes"); // Sellable
  });

  it("defaults an unpopulated price tier to 0, and unset booleans to No/Yes per their DB default", async () => {
    const db = createFakeDb({
      products: [
        {
          org_id: "org1",
          sku: "SKU1",
          name: "Widget",
          category_code: null,
          uom_code: null,
          barcode: null,
          cin7_type: "Stock",
          status: "Active",
          description: null,
          auto_assemble: false,
          sellable: true,
        },
      ],
      price_tiers: [],
    });

    const csv = await exportProductsCsv(db, "org1");
    const fields = parseDataLine(csv.split("\r\n")[1]);
    expect(fields.slice(27, 37)).toEqual(Array(10).fill("0")); // PriceTier1-10
  });
});
