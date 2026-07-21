import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { commitProductRows } from "@/import/commit-products";
import type { ProductCsvRow } from "@/model/products";

/** Minimal in-memory stand-in supporting just .upsert(). */
function createFakeDb() {
  const upserts: Record<string, Record<string, unknown>[]> = {};

  function builder(table: string) {
    return {
      upsert: async (payload: Record<string, unknown>[]) => {
        upserts[table] = [...(upserts[table] ?? []), ...payload];
        return { error: null };
      },
    };
  }

  return { db: { from: builder } as unknown as SupabaseClient, upserts };
}

function productRow(overrides: Partial<ProductCsvRow>): ProductCsvRow {
  return {
    ProductCode: "SKU-1",
    Name: "Widget",
    Category: "",
    Brand: "",
    Type: "",
    FixedAssetType: "",
    CostingMethod: "FIFO",
    WeightUnits: "",
    DimensionUnits: "",
    Barcode: "",
    DefaultLocation: "",
    LastSuppliedBy: "",
    SupplierProductCode: "",
    SupplierProductName: "",
    DefaultUnitOfMeasure: "",
    Status: "",
    Description: "",
    PurchaseTaxRule: "",
    SaleTaxRule: "",
    AutoAssemble: "",
    AutoDisassemble: "",
    DropShip: "",
    DropShipSupplier: "",
    InventoryAccount: "",
    RevenueAccount: "",
    ExpenseAccount: "",
    COGSAccount: "",
    ProductAttributeSet: "",
    AdditionalAttribute1: "",
    AdditionalAttribute2: "",
    AdditionalAttribute3: "",
    AdditionalAttribute4: "",
    AdditionalAttribute5: "",
    AdditionalAttribute6: "",
    AdditionalAttribute7: "",
    AdditionalAttribute8: "",
    AdditionalAttribute9: "",
    AdditionalAttribute10: "",
    DiscountName: "",
    ProductFamilySKU: "",
    ProductFamilyName: "",
    ProductFamilyOption1Name: "",
    ProductFamilyOption1Value: "",
    ProductFamilyOption2Name: "",
    ProductFamilyOption2Value: "",
    ProductFamilyOption3Name: "",
    ProductFamilyOption3Value: "",
    CommaDelimitedTags: "",
    StockLocator: "",
    ShortDescription: "",
    Sellable: "",
    PickZones: "",
    WarrantySetupName: "",
    InternalNote: "",
    MakeToOrderBom: "",
    IsAccountingDimensionEnabled: "",
    DimensionAttribute1: "",
    DimensionAttribute2: "",
    DimensionAttribute3: "",
    DimensionAttribute4: "",
    DimensionAttribute5: "",
    DimensionAttribute6: "",
    DimensionAttribute7: "",
    DimensionAttribute8: "",
    DimensionAttribute9: "",
    DimensionAttribute10: "",
    HSCode: "",
    CountryOfOrigin: "",
    ...overrides,
  };
}

describe("commitProductRows", () => {
  it("upserts one row per unique ProductCode", async () => {
    const { db, upserts } = createFakeDb();
    const summary = await commitProductRows(db, "org1", [productRow({ ProductCode: "SKU-1" }), productRow({ ProductCode: "SKU-2" })]);

    expect(summary.productsUpserted).toBe(2);
    expect(upserts.products).toHaveLength(2);
  });

  it("dedupes rows sharing a ProductCode before upserting, keeping the last occurrence — otherwise Postgres throws \"ON CONFLICT DO UPDATE command cannot affect row a second time\" (confirmed live on a Migrate pull whose source /Product export had duplicate ProductCodes)", async () => {
    const { db, upserts } = createFakeDb();
    const summary = await commitProductRows(db, "org1", [
      productRow({ ProductCode: "SKU-1", Name: "Widget (stale)" }),
      productRow({ ProductCode: "SKU-2" }),
      productRow({ ProductCode: "SKU-1", Name: "Widget (latest)" }),
    ]);

    expect(summary.productsUpserted).toBe(2);
    expect(upserts.products).toHaveLength(2);
    const sku1 = upserts.products.find((p) => p.sku === "SKU-1");
    expect(sku1).toMatchObject({ name: "Widget (latest)" });
  });

  it("dedupes price tiers consistently with the retained product row", async () => {
    const { db, upserts } = createFakeDb();
    await commitProductRows(db, "org1", [
      productRow({ ProductCode: "SKU-1", PriceTier1: 10 }),
      productRow({ ProductCode: "SKU-1", PriceTier1: 20 }),
    ]);

    const tier1Rows = upserts.price_tiers.filter((t) => t.product_sku === "SKU-1" && t.tier_code === "Tier1");
    expect(tier1Rows).toHaveLength(1);
    expect(tier1Rows[0]).toMatchObject({ amount: 20 });
  });
});
