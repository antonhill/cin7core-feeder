import { describe, expect, it } from "vitest";
import {
  findMissingBrand,
  findMissingSalesPricing,
  findInventoryGaps,
  findMissingGLAccounts,
  findDuplicateCategories,
  findDuplicateUOMs,
  findDuplicateTags,
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

  it("includes duplicateUOMs and duplicateTags alongside duplicateCategories", () => {
    const result = runProductAudit([
      product({ SKU: "A", UOM: "Item", Tags: "giftset" }),
      product({ SKU: "B", UOM: "item", Tags: "GIFTSET" }),
    ]);
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
