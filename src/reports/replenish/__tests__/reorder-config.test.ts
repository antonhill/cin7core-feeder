import { describe, expect, it } from "vitest";
import { filterReorderConfigProducts, buildReorderConfigLines, type ReorderConfigProduct } from "@/reports/replenish/reorder-config";
import type { Cin7ReorderLevel } from "@/cin7/product-reorder";

function level(overrides: Partial<Cin7ReorderLevel> & Pick<Cin7ReorderLevel, "locationId" | "locationName">): Cin7ReorderLevel {
  return { minimumBeforeReorder: 10, reorderQuantity: 20, stockLocator: null, pickZones: null, ...overrides };
}

function product(overrides: Partial<ReorderConfigProduct> & Pick<ReorderConfigProduct, "productId" | "sku">): ReorderConfigProduct {
  return { name: overrides.sku, category: null, brand: null, reorderLevels: [], ...overrides };
}

describe("filterReorderConfigProducts", () => {
  const products = [
    product({ productId: "1", sku: "WIDGET", name: "Widget", category: "Apparel", brand: "Acme" }),
    product({ productId: "2", sku: "GADGET", name: "Gadget", category: "Electronics", brand: "Beta Co" }),
    product({ productId: "3", sku: "GIZMO", name: "Gizmo", category: "Apparel", brand: "Beta Co" }),
  ];

  it("with no filters, returns every product", () => {
    expect(filterReorderConfigProducts(products, [], [], "")).toHaveLength(3);
  });

  it("filters by category", () => {
    expect(filterReorderConfigProducts(products, ["Apparel"], [], "").map((p) => p.sku)).toEqual(["WIDGET", "GIZMO"]);
  });

  it("filters by brand", () => {
    expect(filterReorderConfigProducts(products, [], ["Beta Co"], "").map((p) => p.sku)).toEqual(["GADGET", "GIZMO"]);
  });

  it("filters by search against SKU or name, case-insensitive", () => {
    expect(filterReorderConfigProducts(products, [], [], "gadg").map((p) => p.sku)).toEqual(["GADGET"]);
  });

  it("ANDs every filter together", () => {
    expect(filterReorderConfigProducts(products, ["Apparel"], ["Beta Co"], "").map((p) => p.sku)).toEqual(["GIZMO"]);
  });

  it("excludes a product with no brand at all when a brand filter is set", () => {
    const noBrand = [product({ productId: "4", sku: "NOBRAND", brand: null })];
    expect(filterReorderConfigProducts(noBrand, [], ["Acme"], "")).toEqual([]);
  });
});

describe("buildReorderConfigLines", () => {
  it("updates an existing entry for the target location, preserving every other location's entry untouched", () => {
    const products = [
      product({
        productId: "1",
        sku: "WIDGET",
        reorderLevels: [
          level({ locationId: "loc-a", locationName: "Warehouse A", minimumBeforeReorder: 5, reorderQuantity: 15 }),
          level({ locationId: "loc-b", locationName: "Warehouse B", minimumBeforeReorder: 8, reorderQuantity: 25 }),
        ],
      }),
    ];

    const lines = buildReorderConfigLines(products, new Set(["1"]), "loc-a", "Warehouse A", 20, 40);

    expect(lines).toHaveLength(1);
    expect(lines[0].currentMinimum).toBe(5);
    expect(lines[0].currentReorderQuantity).toBe(15);
    expect(lines[0].newMinimum).toBe(20);
    expect(lines[0].newReorderQuantity).toBe(40);
    expect(lines[0].newReorderLevels).toEqual([
      { locationId: "loc-a", locationName: "Warehouse A", minimumBeforeReorder: 20, reorderQuantity: 40, stockLocator: null, pickZones: null },
      level({ locationId: "loc-b", locationName: "Warehouse B", minimumBeforeReorder: 8, reorderQuantity: 25 }),
    ]);
  });

  it("appends a brand-new entry when the product has no existing entry for the target location", () => {
    const products = [
      product({
        productId: "1",
        sku: "WIDGET",
        reorderLevels: [level({ locationId: "loc-a", locationName: "Warehouse A" })],
      }),
    ];

    const lines = buildReorderConfigLines(products, new Set(["1"]), "loc-c", "Warehouse C", 12, 24);

    expect(lines[0].currentMinimum).toBeNull();
    expect(lines[0].currentReorderQuantity).toBeNull();
    expect(lines[0].newReorderLevels).toHaveLength(2);
    expect(lines[0].newReorderLevels[1]).toEqual({
      locationId: "loc-c",
      locationName: "Warehouse C",
      minimumBeforeReorder: 12,
      reorderQuantity: 24,
      stockLocator: null,
      pickZones: null,
    });
  });

  it("preserves an existing entry's stockLocator/pickZones when only the reorder values change", () => {
    const products = [
      product({
        productId: "1",
        sku: "WIDGET",
        reorderLevels: [level({ locationId: "loc-a", locationName: "Warehouse A", stockLocator: "Aisle 3", pickZones: "A,B" })],
      }),
    ];

    const lines = buildReorderConfigLines(products, new Set(["1"]), "loc-a", "Warehouse A", 99, 199);
    expect(lines[0].newReorderLevels[0]).toMatchObject({ stockLocator: "Aisle 3", pickZones: "A,B" });
  });

  it("skips a product whose target location already has these exact values (no-op)", () => {
    const products = [
      product({
        productId: "1",
        sku: "WIDGET",
        reorderLevels: [level({ locationId: "loc-a", locationName: "Warehouse A", minimumBeforeReorder: 10, reorderQuantity: 20 })],
      }),
    ];

    const lines = buildReorderConfigLines(products, new Set(["1"]), "loc-a", "Warehouse A", 10, 20);
    expect(lines).toEqual([]);
  });

  it("only applies to selected products, not every product passed in", () => {
    const products = [product({ productId: "1", sku: "WIDGET" }), product({ productId: "2", sku: "GADGET" })];
    const lines = buildReorderConfigLines(products, new Set(["1"]), "loc-a", "Warehouse A", 5, 10);
    expect(lines.map((l) => l.productId)).toEqual(["1"]);
  });
});
