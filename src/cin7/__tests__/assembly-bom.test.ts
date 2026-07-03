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

  it("includes the required parent-level fields when BillOfMaterial is true", () => {
    const fields = toCin7BomFields([line({})]);
    expect(fields.BillOfMaterial).toBe(true);
    expect(fields.QuantityToProduce).toBe(1);
    expect(fields.AssemblyCostEstimationMethod).toBe("Average Cost");
  });

  it("classifies a stock line as a BillOfMaterialsProducts entry, referenced by SKU with the confirmed field names", () => {
    const fields = toCin7BomFields([
      line({ component_sku: "COMP", quantity: 2, wastage_percent: 5, cost_percentage: 50 }),
    ]);
    expect(fields.BillOfMaterialsProducts).toEqual([
      expect.objectContaining({ ProductCode: "COMP", Quantity: 2, WastagePercent: 5, CostPercentage: 50 }),
    ]);
    expect(fields.BillOfMaterialsServices).toBeUndefined();
  });

  it("classifies a line with a PriceTier/ExpenseAccount as a BillOfMaterialsServices entry, keyed by Name not ProductCode", () => {
    const fields = toCin7BomFields([
      line({ component_sku: "LAB-001", price_tier: "Retail", expense_account: "260: COGS" }),
    ]);
    expect(fields.BillOfMaterialsServices).toEqual([
      expect.objectContaining({ Name: "LAB-001", ExpenseAccount: "260: COGS" }),
    ]);
    const services = fields.BillOfMaterialsServices as Record<string, unknown>[];
    expect(services[0]).not.toHaveProperty("ProductCode");
    expect(fields.BillOfMaterialsProducts).toBeUndefined();
  });

  it("omits BillOfMaterialsProducts/Services entirely when empty, rather than sending an empty array", () => {
    const fields = toCin7BomFields([line({ price_tier: "Retail" })]); // service-only
    expect(fields).not.toHaveProperty("BillOfMaterialsProducts");
    expect(fields.BillOfMaterialsServices).toHaveLength(1);
  });
});
