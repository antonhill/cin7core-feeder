import { describe, expect, it } from "vitest";
import { filterPriceableProducts, buildPriceUpdateLines, type PriceableProduct } from "@/pricing/build";

function product(overrides: Partial<PriceableProduct> & Pick<PriceableProduct, "productId" | "sku">): PriceableProduct {
  return {
    name: overrides.sku,
    category: null,
    supplierNames: [],
    priceTierValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    ...overrides,
  };
}

describe("filterPriceableProducts", () => {
  const products = [
    product({ productId: "1", sku: "WIDGET", name: "Widget", category: "Apparel", supplierNames: ["Acme"] }),
    product({ productId: "2", sku: "GADGET", name: "Gadget", category: "Electronics", supplierNames: ["Beta Co"] }),
    product({ productId: "3", sku: "GIZMO", name: "Gizmo", category: "Apparel", supplierNames: ["Beta Co"] }),
  ];

  it("with no filters set, returns every product", () => {
    expect(filterPriceableProducts(products, [], [], "")).toHaveLength(3);
  });

  it("filters by category", () => {
    const result = filterPriceableProducts(products, ["Apparel"], [], "");
    expect(result.map((p) => p.sku)).toEqual(["WIDGET", "GIZMO"]);
  });

  it("filters by supplier", () => {
    const result = filterPriceableProducts(products, [], ["Beta Co"], "");
    expect(result.map((p) => p.sku)).toEqual(["GADGET", "GIZMO"]);
  });

  it("filters by search against SKU or name, case-insensitive", () => {
    expect(filterPriceableProducts(products, [], [], "gadg").map((p) => p.sku)).toEqual(["GADGET"]);
    expect(filterPriceableProducts(products, [], [], "WIDGET").map((p) => p.sku)).toEqual(["WIDGET"]);
  });

  it("ANDs every filter together", () => {
    const result = filterPriceableProducts(products, ["Apparel"], ["Beta Co"], "");
    expect(result.map((p) => p.sku)).toEqual(["GIZMO"]);
  });

  it("excludes a product with no category at all when a category filter is set", () => {
    const uncategorized = [product({ productId: "4", sku: "NOCAT", category: null })];
    expect(filterPriceableProducts(uncategorized, ["Apparel"], [], "")).toEqual([]);
  });
});

describe("buildPriceUpdateLines", () => {
  it("'set' mode applies the same flat value to every selected product regardless of its current price", () => {
    const products = [
      product({ productId: "1", sku: "WIDGET", priceTierValues: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0] }),
      product({ productId: "2", sku: "GADGET", priceTierValues: [25, 0, 0, 0, 0, 0, 0, 0, 0, 0] }),
    ];
    const lines = buildPriceUpdateLines(products, new Set(["1", "2"]), 0, "set", 19.99);
    expect(lines).toEqual([
      { productId: "1", sku: "WIDGET", name: "WIDGET", tierIndex: 0, currentValue: 10, newValue: 19.99 },
      { productId: "2", sku: "GADGET", name: "GADGET", tierIndex: 0, currentValue: 25, newValue: 19.99 },
    ]);
  });

  it("'increase_percent' mode multiplies each product's own current value, rounded to 2 decimals", () => {
    const products = [product({ productId: "1", sku: "WIDGET", priceTierValues: [100, 0, 0, 0, 0, 0, 0, 0, 0, 0] })];
    const lines = buildPriceUpdateLines(products, new Set(["1"]), 0, "increase_percent", 12.5);
    expect(lines).toEqual([{ productId: "1", sku: "WIDGET", name: "WIDGET", tierIndex: 0, currentValue: 100, newValue: 112.5 }]);
  });

  it("only applies to the selected products, not every filtered product", () => {
    const products = [
      product({ productId: "1", sku: "WIDGET", priceTierValues: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0] }),
      product({ productId: "2", sku: "GADGET", priceTierValues: [10, 0, 0, 0, 0, 0, 0, 0, 0, 0] }),
    ];
    const lines = buildPriceUpdateLines(products, new Set(["1"]), 0, "set", 50);
    expect(lines.map((l) => l.productId)).toEqual(["1"]);
  });

  it("skips a product whose computed new value doesn't actually change (no-op)", () => {
    const products = [product({ productId: "1", sku: "WIDGET", priceTierValues: [50, 0, 0, 0, 0, 0, 0, 0, 0, 0] })];
    const lines = buildPriceUpdateLines(products, new Set(["1"]), 0, "set", 50);
    expect(lines).toEqual([]);
  });

  it("a product with 0 (never configured) in the chosen tier stays 0 under a % increase, and is skipped as a no-op", () => {
    const products = [product({ productId: "1", sku: "WIDGET", priceTierValues: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] })];
    const lines = buildPriceUpdateLines(products, new Set(["1"]), 0, "increase_percent", 20);
    expect(lines).toEqual([]);
  });

  it("operates on the tier index requested, leaving other tiers alone", () => {
    const products = [product({ productId: "1", sku: "WIDGET", priceTierValues: [10, 20, 30, 0, 0, 0, 0, 0, 0, 0] })];
    const lines = buildPriceUpdateLines(products, new Set(["1"]), 2, "set", 99);
    expect(lines).toEqual([{ productId: "1", sku: "WIDGET", name: "WIDGET", tierIndex: 2, currentValue: 30, newValue: 99 }]);
  });
});
