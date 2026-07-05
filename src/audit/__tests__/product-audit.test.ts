import { describe, expect, it } from "vitest";
import {
  findMissingBrand,
  findMissingSalesPricing,
  findInventoryGaps,
  findMissingGLAccounts,
  findDuplicateCategories,
  runProductAudit,
} from "@/audit/product-audit";

function product(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    ID: "id-1",
    SKU: "SKU-1",
    Name: "Widget",
    Category: "Widgets",
    Brand: "Acme",
    Type: "Stock",
    DefaultLocation: "Main Warehouse",
    UOM: "Item",
    InventoryAccount: "630",
    RevenueAccount: "200",
    COGSAccount: "310",
    PriceTier1: 10,
    ...overrides,
  };
}

describe("findMissingBrand", () => {
  it("flags a product with a blank Brand", () => {
    const issues = findMissingBrand([product({ SKU: "A", Brand: "" }), product({ SKU: "B", Brand: "Acme" })]);
    expect(issues).toEqual([{ type: "missing_brand", productId: "id-1", sku: "A", name: "Widget" }]);
  });

  it("treats a whitespace-only Brand as blank", () => {
    expect(findMissingBrand([product({ Brand: "   " })])).toHaveLength(1);
  });
});

describe("findMissingSalesPricing", () => {
  it("flags a product with every price tier blank or zero", () => {
    const issues = findMissingSalesPricing([product({ SKU: "A", PriceTier1: 0, PriceTier2: undefined })]);
    expect(issues).toEqual([{ type: "missing_sales_pricing", productId: "id-1", sku: "A", name: "Widget" }]);
  });

  it("does not flag a product with any positive tier, even a non-Tier-1 one", () => {
    const issues = findMissingSalesPricing([product({ PriceTier1: 0, PriceTier5: 25 })]);
    expect(issues).toEqual([]);
  });
});

describe("findInventoryGaps", () => {
  it("flags a Stock product missing DefaultLocation, UOM, or InventoryAccount — one issue per missing field", () => {
    const issues = findInventoryGaps([product({ SKU: "A", DefaultLocation: "", UOM: "", InventoryAccount: "630" })]);
    expect(issues).toEqual([
      { type: "missing_location", productId: "id-1", sku: "A", name: "Widget" },
      { type: "missing_uom", productId: "id-1", sku: "A", name: "Widget" },
    ]);
  });

  it("exempts Service/Fixed Asset products entirely — they're never stock-tracked", () => {
    const issues = findInventoryGaps([product({ Type: "Service", DefaultLocation: "", UOM: "", InventoryAccount: "" })]);
    expect(issues).toEqual([]);
  });

  it("does not flag a fully-configured Stock product", () => {
    expect(findInventoryGaps([product({})])).toEqual([]);
  });
});

describe("findMissingGLAccounts", () => {
  it("flags RevenueAccount and COGSAccount independently", () => {
    const issues = findMissingGLAccounts([product({ SKU: "A", RevenueAccount: "", COGSAccount: "310" })]);
    expect(issues).toEqual([{ type: "missing_revenue_account", productId: "id-1", sku: "A", name: "Widget" }]);
  });

  it("flags both when both are blank", () => {
    const issues = findMissingGLAccounts([product({ RevenueAccount: "", COGSAccount: "" })]);
    expect(issues.map((i) => i.type)).toEqual(["missing_revenue_account", "missing_cogs_account"]);
  });
});

describe("findDuplicateCategories", () => {
  it("groups a trailing-whitespace variant as a duplicate", () => {
    const groups = findDuplicateCategories([
      product({ Category: "Widgets" }),
      product({ Category: "Widgets" }),
      product({ Category: "Widgets " }),
    ]);
    expect(groups).toEqual([
      {
        names: expect.arrayContaining([
          { name: "Widgets", productCount: 2 },
          { name: "Widgets ", productCount: 1 },
        ]),
      },
    ]);
  });

  it("groups a near-miss spelling within the proportional edit-distance threshold", () => {
    const groups = findDuplicateCategories([
      ...Array(47).fill(null).map(() => product({ Category: "Home Decor" })),
      ...Array(3).fill(null).map(() => product({ Category: "Home Decore" })),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].names.map((n) => n.name).sort()).toEqual(["Home Decor", "Home Decore"]);
    expect(groups[0].names.find((n) => n.name === "Home Decor")?.productCount).toBe(47);
    expect(groups[0].names.find((n) => n.name === "Home Decore")?.productCount).toBe(3);
  });

  it("does not group genuinely distinct categories, even short ones", () => {
    const groups = findDuplicateCategories([product({ Category: "Bar" }), product({ Category: "Car" })]);
    expect(groups).toEqual([]);
  });

  it("does not group distinct multi-word categories that happen to share a prefix", () => {
    const groups = findDuplicateCategories([product({ Category: "Kitchen Appliances" }), product({ Category: "Kitchen Tools" })]);
    expect(groups).toEqual([]);
  });

  it("ignores blank categories", () => {
    expect(findDuplicateCategories([product({ Category: "" }), product({ Category: undefined })])).toEqual([]);
  });
});

describe("runProductAudit", () => {
  it("aggregates every check into one result", () => {
    const result = runProductAudit([
      product({ SKU: "A", Brand: "", Category: "Widgets" }),
      product({ SKU: "B", Category: "Widgets " }),
    ]);
    expect(result.issues.some((i) => i.type === "missing_brand" && i.sku === "A")).toBe(true);
    expect(result.duplicateCategories).toHaveLength(1);
  });
});
