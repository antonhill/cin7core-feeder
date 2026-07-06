import { describe, expect, it } from "vitest";
import {
  findMissingBrand,
  findMissingSalesPricing,
  findInventoryGaps,
  findMissingGLAccounts,
  findDuplicateCategories,
  findDuplicateBrands,
  findDuplicateUOMs,
  findDuplicateTags,
  findAttributeGaps,
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
    Tags: "",
    Sellable: true,
    ...overrides,
  };
}

describe("findMissingBrand", () => {
  it("flags a product with a blank Brand", () => {
    const issues = findMissingBrand([product({ SKU: "A", Brand: "" }), product({ SKU: "B", Brand: "Acme" })]);
    expect(issues).toEqual([{ type: "missing_brand", productId: "id-1", sku: "A", name: "Widget", category: "Widgets" }]);
  });

  it("treats a whitespace-only Brand as blank", () => {
    expect(findMissingBrand([product({ Brand: "   " })])).toHaveLength(1);
  });
});

describe("findMissingSalesPricing", () => {
  it("flags a product with every price tier blank or zero", () => {
    const issues = findMissingSalesPricing([product({ SKU: "A", PriceTier1: 0, PriceTier2: undefined })]);
    expect(issues).toEqual([{ type: "missing_sales_pricing", productId: "id-1", sku: "A", name: "Widget", category: "Widgets" }]);
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
      { type: "missing_location", productId: "id-1", sku: "A", name: "Widget", category: "Widgets" },
      { type: "missing_uom", productId: "id-1", sku: "A", name: "Widget", category: "Widgets" },
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
    expect(issues).toEqual([{ type: "missing_revenue_account", productId: "id-1", sku: "A", name: "Widget", category: "Widgets" }]);
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

describe("findDuplicateBrands", () => {
  it("groups a casing variant as a duplicate, same rule as categories", () => {
    const groups = findDuplicateBrands([product({ Brand: "Acme" }), product({ Brand: "acme" }), product({ Brand: "Acme" })]);
    expect(groups).toEqual([
      {
        names: expect.arrayContaining([
          { name: "Acme", productCount: 2 },
          { name: "acme", productCount: 1 },
        ]),
      },
    ]);
  });

  it("ignores blank brands", () => {
    expect(findDuplicateBrands([product({ Brand: "" }), product({ Brand: undefined })])).toEqual([]);
  });
});

describe("findDuplicateUOMs", () => {
  it("groups a casing variant as a duplicate, same rule as categories", () => {
    const groups = findDuplicateUOMs([product({ UOM: "Item" }), product({ UOM: "item" }), product({ UOM: "Item" })]);
    expect(groups).toEqual([
      {
        names: expect.arrayContaining([
          { name: "Item", productCount: 2 },
          { name: "item", productCount: 1 },
        ]),
      },
    ]);
  });

  it("ignores blank UOMs", () => {
    expect(findDuplicateUOMs([product({ UOM: "" }), product({ UOM: undefined })])).toEqual([]);
  });
});

describe("findDuplicateTags", () => {
  it("splits each product's comma-delimited Tags and counts individual tokens across the catalog", () => {
    const groups = findDuplicateTags([
      product({ Tags: "giftset,fragile" }),
      product({ Tags: "GIFTSET" }),
      product({ Tags: "fragile" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].names.map((n) => n.name).sort()).toEqual(["GIFTSET", "giftset"]);
    // "fragile" appears on 2 products but has no near-duplicate variant, so it isn't part of any group.
  });

  it("ignores a product with no Tags at all", () => {
    expect(findDuplicateTags([product({ Tags: "" }), product({ Tags: undefined })])).toEqual([]);
  });

  it("catches a leading-space token from a 'tag, tag' style list as a duplicate of the same tag written cleanly elsewhere", () => {
    // "fragile, giftset".split(",") -> ["fragile", " giftset"] (untrimmed) — same
    // deliberate not-trimmed-before-counting rule as categories, so this
    // whitespace variant is exactly the kind of duplicate this check should catch.
    const groups = findDuplicateTags([product({ Tags: "fragile, giftset" }), product({ Tags: "giftset" })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].names.map((n) => n.name)).toEqual(expect.arrayContaining([" giftset", "giftset"]));
  });
});

describe("findAttributeGaps", () => {
  it("flags a slot that's filled on most of a category's products but blank on one", () => {
    const groups = findAttributeGaps([
      product({ SKU: "A", ID: "id-a", Category: "T-Shirts", AdditionalAttribute1: "Small" }),
      product({ SKU: "B", ID: "id-b", Category: "T-Shirts", AdditionalAttribute1: "Medium" }),
      product({ SKU: "C", ID: "id-c", Category: "T-Shirts", AdditionalAttribute1: "" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].category).toBe("T-Shirts");
    expect(groups[0].slots).toEqual([1]);
    expect(groups[0].products).toEqual([{ productId: "id-c", sku: "C", name: "Widget", missingSlots: [1] }]);
    expect(groups[0].templates.map((t) => t.productId).sort()).toEqual(["id-a", "id-b"]);
  });

  it("does not flag a slot that's blank on most of the category — that's just an unused slot, not a gap", () => {
    const groups = findAttributeGaps([
      product({ Category: "Widgets", AdditionalAttribute1: "X" }),
      product({ Category: "Widgets", AdditionalAttribute1: "" }),
      product({ Category: "Widgets", AdditionalAttribute1: "" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("does not flag a fully-consistent category, whether entirely filled or entirely blank", () => {
    const groups = findAttributeGaps([
      product({ Category: "Filled", AdditionalAttribute1: "X" }),
      product({ Category: "Filled", AdditionalAttribute1: "Y" }),
      product({ Category: "Blank", AdditionalAttribute1: "" }),
      product({ Category: "Blank", AdditionalAttribute1: "" }),
    ]);
    expect(groups).toEqual([]);
  });

  it("skips products with no category — nothing to compare them against", () => {
    expect(findAttributeGaps([product({ Category: "", AdditionalAttribute1: "" }), product({ Category: undefined })])).toEqual([]);
  });

  it("tracks multiple gappy slots independently within the same category", () => {
    const groups = findAttributeGaps([
      product({ SKU: "A", ID: "id-a", Category: "Widgets", AdditionalAttribute1: "X", AdditionalAttribute2: "Y" }),
      product({ SKU: "B", ID: "id-b", Category: "Widgets", AdditionalAttribute1: "X", AdditionalAttribute2: "" }),
      product({ SKU: "C", ID: "id-c", Category: "Widgets", AdditionalAttribute1: "", AdditionalAttribute2: "Y" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].slots).toEqual([1, 2]);
    expect(groups[0].products.find((p) => p.productId === "id-b")?.missingSlots).toEqual([2]);
    expect(groups[0].products.find((p) => p.productId === "id-c")?.missingSlots).toEqual([1]);
    expect(groups[0].templates).toEqual([{ productId: "id-a", sku: "A", name: "Widget" }]); // the only product with both gappy slots filled
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

  it("lists every distinct category seen, even ones with zero issues — so a fully-clean category still shows up as a filter option", () => {
    const result = runProductAudit([
      product({ SKU: "A", Category: "Finished Products" }), // fully configured, no issues
      product({ SKU: "B", Category: "Raw Materials", Brand: "" }), // has an issue
      product({ SKU: "C", Category: "" }), // blank category — excluded from the filter list
    ]);
    expect(result.categories).toEqual(["Finished Products", "Raw Materials"]);
  });

  it("tags each issue with the product's own category, so issues can be filtered by it", () => {
    const result = runProductAudit([product({ SKU: "A", Category: "Finished Products", Brand: "" })]);
    expect(result.issues[0].category).toBe("Finished Products");
  });

  it("includes attributeGaps alongside the duplicate checks", () => {
    const result = runProductAudit([
      product({ SKU: "A", Category: "Widgets", AdditionalAttribute1: "X" }),
      product({ SKU: "B", Category: "Widgets", AdditionalAttribute1: "X" }),
      product({ SKU: "C", Category: "Widgets", AdditionalAttribute1: "" }),
    ]);
    expect(result.attributeGaps).toHaveLength(1);
    expect(result.attributeGaps[0].category).toBe("Widgets");
  });

  it("includes duplicateBrands, duplicateUOMs and duplicateTags alongside duplicateCategories", () => {
    const result = runProductAudit([
      product({ SKU: "A", Brand: "Acme", UOM: "Item", Tags: "giftset" }),
      product({ SKU: "B", Brand: "acme", UOM: "item", Tags: "GIFTSET" }),
    ]);
    expect(result.duplicateBrands).toHaveLength(1);
    expect(result.duplicateUOMs).toHaveLength(1);
    expect(result.duplicateTags).toHaveLength(1);
  });

  it("builds a full product roster for the Sellable bulk-editor and search/filter, independent of any detected issue", () => {
    const result = runProductAudit([
      product({ SKU: "A", ID: "id-a", Name: "Widget A", Category: "Finished Products", Sellable: true }),
      product({ SKU: "B", ID: "id-b", Name: "Widget B", Category: "Raw Materials", Sellable: false }),
    ]);
    expect(result.products).toEqual([
      { productId: "id-a", sku: "A", name: "Widget A", category: "Finished Products", sellable: true },
      { productId: "id-b", sku: "B", name: "Widget B", category: "Raw Materials", sellable: false },
    ]);
  });
});
