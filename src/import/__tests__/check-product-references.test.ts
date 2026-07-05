import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedRow } from "@/import/csv";
import { checkProductSupplierReference } from "@/import/check-product-references";
import type { ProductCsvRow } from "@/model/products";

/** Minimal stand-in for the one query shape findMissingSupplierNames actually issues. */
function fakeDb(existingNames: string[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: (_col: string, names: string[]) =>
            Promise.resolve({
              data: names.filter((n) => existingNames.includes(n)).map((name) => ({ name })),
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function productRow(overrides: Partial<ProductCsvRow>, rowNumber = 1): ParsedRow<ProductCsvRow> {
  const data: ProductCsvRow = {
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
  return { rowNumber, raw: data as Record<string, unknown>, data };
}

describe("checkProductSupplierReference", () => {
  it("does not warn when LastSuppliedBy is blank", async () => {
    const db = fakeDb([]);
    const warnings = await checkProductSupplierReference(db, "org1", [productRow({ LastSuppliedBy: "" })]);
    expect(warnings).toEqual([]);
  });

  it("does not warn when LastSuppliedBy matches an existing supplier", async () => {
    const db = fakeDb(["ABC Suppliers"]);
    const warnings = await checkProductSupplierReference(db, "org1", [productRow({ LastSuppliedBy: "ABC Suppliers" })]);
    expect(warnings).toEqual([]);
  });

  it("warns when LastSuppliedBy doesn't match any existing supplier", async () => {
    const db = fakeDb([]);
    const warnings = await checkProductSupplierReference(db, "org1", [productRow({ LastSuppliedBy: "XYZ Suppliers" })]);
    expect(warnings).toEqual([
      {
        rowNumber: 1,
        message: '"Widget": LastSuppliedBy "XYZ Suppliers" doesn\'t match any existing supplier — check it\'s been imported, or that it\'s not a typo',
      },
    ]);
  });
});
