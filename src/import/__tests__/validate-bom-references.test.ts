import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedRow } from "@/import/csv";
import { checkAssemblyBomReferences, checkProductionBomReferences } from "@/import/validate-bom-references";
import type { AssemblyBomCsvRow } from "@/model/assembly-bom";
import type { ProductionBomCsvRow } from "@/model/production-bom";

/** Minimal stand-in for the one query shape findMissingSkus actually issues. */
function fakeDb(existingSkus: string[]): SupabaseClient {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: (_col: string, skus: string[]) =>
            Promise.resolve({
              data: skus.filter((s) => existingSkus.includes(s)).map((sku) => ({ sku })),
              error: null,
            }),
        }),
      }),
    }),
  } as unknown as SupabaseClient;
}

function assemblyRow(overrides: Partial<AssemblyBomCsvRow>, rowNumber = 1): ParsedRow<AssemblyBomCsvRow> {
  const data: AssemblyBomCsvRow = {
    Action: "Create/Update",
    ProductSKU: "PARENT",
    ProductName: "Parent",
    ComponentSKU: "COMP",
    ComponentName: "Component",
    Quantity: 1,
    PriceTier_ForServiceComponentOnly: "",
    ExpenseAccount_ForServiceComponentOnly: "",
    ...overrides,
  };
  return { rowNumber, raw: data as Record<string, unknown>, data };
}

function productionRow(overrides: Partial<ProductionBomCsvRow>, rowNumber = 1): ParsedRow<ProductionBomCsvRow> {
  const data = {
    Action: "Create/Update",
    ProductSKU: "PARENT",
    ProductName: "Parent",
    QuantityToProduce: 1,
    BufferPercent: 0,
    ProductionInstructionUrl: "",
    IgnoreCumulativeLeadTime: false,
    Version: "1",
    VersionName: "",
    VersionDefault: false,
    OperationSequence: "1",
    OperationType: "Manufacturing",
    OperationName: "",
    WorkCentreCode: "",
    WorkCentreName: "",
    PreviousStep: "",
    ItemType: "Component" as const,
    ComponentSKU_ResourceCode: "COMP",
    ComponentName_ResourceName: "",
    Quantity: 1,
    CostAllocationType: "",
    DeliveryTo_LocationName: "",
    DeliveryTo_BinName: "",
    CoManPriceTier: "",
    Tracing: "",
    IssueMethodComponent: "",
    OperationIsBackflush: false,
    ComponentIsBackflush: false,
    ResourceCostType: "",
    ...overrides,
  } as ProductionBomCsvRow;
  return { rowNumber, raw: data as Record<string, unknown>, data };
}

describe("checkAssemblyBomReferences", () => {
  it("passes a row whose parent and component both already exist", async () => {
    const db = fakeDb(["PARENT", "COMP"]);
    const { valid, invalid } = await checkAssemblyBomReferences(db, "org1", [assemblyRow({})]);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  it("rejects a row whose parent SKU doesn't exist", async () => {
    const db = fakeDb(["COMP"]);
    const { valid, invalid } = await checkAssemblyBomReferences(db, "org1", [assemblyRow({})]);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].errors[0]).toMatch(/ProductSKU "PARENT" does not exist/);
  });

  it("rejects a row whose component SKU doesn't exist", async () => {
    const db = fakeDb(["PARENT"]);
    const { valid, invalid } = await checkAssemblyBomReferences(db, "org1", [assemblyRow({})]);
    expect(valid).toHaveLength(0);
    expect(invalid[0].errors[0]).toMatch(/ComponentSKU "COMP" does not exist/);
  });
});

describe("checkProductionBomReferences", () => {
  it("passes a Component item row whose parent and component both exist", async () => {
    const db = fakeDb(["PARENT", "COMP"]);
    const { valid, invalid } = await checkProductionBomReferences(db, "org1", [productionRow({})]);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  it("rejects a Component item row referencing an unknown component SKU", async () => {
    const db = fakeDb(["PARENT"]);
    const { valid, invalid } = await checkProductionBomReferences(db, "org1", [productionRow({})]);
    expect(valid).toHaveLength(0);
    expect(invalid[0].errors[0]).toMatch(/ComponentSKU "COMP" does not exist/);
  });

  it("does not require a Resource item's code to exist as a product", async () => {
    const db = fakeDb(["PARENT"]); // "LAB1" resource code deliberately absent from products
    const row = productionRow({ ItemType: "Resource", ComponentSKU_ResourceCode: "LAB1" });
    const { valid, invalid } = await checkProductionBomReferences(db, "org1", [row]);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });
});
