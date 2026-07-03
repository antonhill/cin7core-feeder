import { describe, expect, it } from "vitest";
import { toCin7BomFields, type CanonicalAssemblyBomLineRow } from "@/cin7/assembly-bom";

function line(overrides: Partial<CanonicalAssemblyBomLineRow>): CanonicalAssemblyBomLineRow {
  return {
    product_sku: "PARENT",
    component_sku: "COMP",
    quantity: 1,
    wastage_quantity: null,
    wastage_percent: null,
    cost_percentage: null,
    price_tier: null,
    expense_account: null,
    ...overrides,
  };
}

describe("toCin7BomFields", () => {
  it("returns no fields for a product with no BOM lines", () => {
    expect(toCin7BomFields([])).toEqual({});
  });

  it("classifies a stock line as a BillOfMaterialsProducts entry, referenced by SKU", () => {
    const fields = toCin7BomFields([line({ component_sku: "COMP", quantity: 2 })]);
    expect(fields.BillOfMaterial).toBe(true);
    expect(fields.BillOfMaterialsProducts).toEqual([
      expect.objectContaining({ ProductCode: "COMP", Quantity: 2 }),
    ]);
    expect(fields.BillOfMaterialsServices).toHaveLength(0);
  });

  it("classifies a line with a PriceTier/ExpenseAccount as a BillOfMaterialsServices entry", () => {
    const fields = toCin7BomFields([
      line({ component_sku: "LAB-001", price_tier: "Retail", expense_account: "260: COGS" }),
    ]);
    expect(fields.BillOfMaterialsServices).toEqual([
      expect.objectContaining({ ProductCode: "LAB-001", PriceTier: "Retail", ExpenseAccount: "260: COGS" }),
    ]);
    expect(fields.BillOfMaterialsProducts).toHaveLength(0);
  });
});
