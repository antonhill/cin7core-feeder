import { describe, expect, it } from "vitest";
import { resolveReorderThresholds, buildReplenishLines, type AvailabilityRow, type ReplenishProductInput } from "@/reports/replenish/build";

describe("resolveReorderThresholds", () => {
  it("uses a location's own ReorderLevels entry over the product's flat fallback", () => {
    const products: ReplenishProductInput[] = [
      {
        sku: "WIDGET",
        minimumBeforeReorder: 5,
        reorderQuantity: 10,
        reorderLevels: [{ locationName: "Store A", minimumBeforeReorder: 20, reorderQuantity: 40 }],
      },
    ];
    const rows = [{ productSku: "WIDGET", location: "Store A" }];

    const { thresholds } = resolveReorderThresholds(rows, products);
    expect(thresholds.get("WIDGET::Store A")).toEqual({ minimumBeforeReorder: 20, reorderQuantity: 40 });
  });

  it("falls back to the product's flat threshold when a location has no ReorderLevels entry", () => {
    const products: ReplenishProductInput[] = [{ sku: "WIDGET", minimumBeforeReorder: 5, reorderQuantity: 10, reorderLevels: [] }];
    const rows = [{ productSku: "WIDGET", location: "Store B" }];

    const { thresholds } = resolveReorderThresholds(rows, products);
    expect(thresholds.get("WIDGET::Store B")).toEqual({ minimumBeforeReorder: 5, reorderQuantity: 10 });
  });

  it("excludes a product with neither a location-level nor flat threshold, and counts it toward skusWithNoThreshold", () => {
    const products: ReplenishProductInput[] = [{ sku: "UNCONFIGURED", minimumBeforeReorder: 0, reorderQuantity: 0, reorderLevels: [] }];
    const rows = [{ productSku: "UNCONFIGURED", location: "Store A" }];

    const { thresholds, skusWithNoThreshold } = resolveReorderThresholds(rows, products);
    expect(thresholds.size).toBe(0);
    expect(skusWithNoThreshold).toEqual(new Set(["UNCONFIGURED"]));
  });

  it("does not count a SKU toward skusWithNoThreshold if at least one of its locations resolved a real threshold", () => {
    const products: ReplenishProductInput[] = [
      {
        sku: "WIDGET",
        minimumBeforeReorder: 0,
        reorderQuantity: 0,
        reorderLevels: [{ locationName: "Store A", minimumBeforeReorder: 10, reorderQuantity: 5 }],
      },
    ];
    const rows = [
      { productSku: "WIDGET", location: "Store A" },
      { productSku: "WIDGET", location: "Store B" },
    ];

    const { skusWithNoThreshold } = resolveReorderThresholds(rows, products);
    expect(skusWithNoThreshold.has("WIDGET")).toBe(false);
  });
});

describe("buildReplenishLines", () => {
  it("proposes a transfer covering the full shortfall when the source has enough surplus", () => {
    const rows: AvailabilityRow[] = [
      { location: "Main Warehouse", productSku: "WIDGET", productName: "Widget", onHand: 100 },
      { location: "Store A", productSku: "WIDGET", productName: "Widget", onHand: 2 },
    ];
    const thresholds = new Map([["WIDGET::Store A", { minimumBeforeReorder: 10, reorderQuantity: 5 }]]);

    const lines = buildReplenishLines(rows, thresholds, "Main Warehouse");

    // target = 10 + 5 = 15; shortfall = 15 - 2 = 13
    expect(lines).toEqual([{ productSku: "WIDGET", productName: "Widget", fromLocation: "Main Warehouse", toLocation: "Store A", quantity: 13, capped: false }]);
  });

  it("excludes a destination already at or above its target (no line emitted)", () => {
    const rows: AvailabilityRow[] = [
      { location: "Main Warehouse", productSku: "WIDGET", productName: "Widget", onHand: 100 },
      { location: "Store A", productSku: "WIDGET", productName: "Widget", onHand: 50 },
    ];
    const thresholds = new Map([["WIDGET::Store A", { minimumBeforeReorder: 10, reorderQuantity: 5 }]]);

    const lines = buildReplenishLines(rows, thresholds, "Main Warehouse");
    expect(lines).toEqual([]);
  });

  it("caps the proposed quantity to the source's own surplus and flags it", () => {
    const rows: AvailabilityRow[] = [
      { location: "Main Warehouse", productSku: "WIDGET", productName: "Widget", onHand: 5 },
      { location: "Store A", productSku: "WIDGET", productName: "Widget", onHand: 0 },
    ];
    const thresholds = new Map([["WIDGET::Store A", { minimumBeforeReorder: 10, reorderQuantity: 5 }]]);

    const lines = buildReplenishLines(rows, thresholds, "Main Warehouse");

    // target = 15; shortfall = 15; source only has 5.
    expect(lines).toEqual([{ productSku: "WIDGET", productName: "Widget", fromLocation: "Main Warehouse", toLocation: "Store A", quantity: 5, capped: true }]);
  });

  it("splits a limited source across two destinations, largest-shortfall location first", () => {
    const rows: AvailabilityRow[] = [
      { location: "Main Warehouse", productSku: "WIDGET", productName: "Widget", onHand: 12 },
      { location: "Store A", productSku: "WIDGET", productName: "Widget", onHand: 0 }, // shortfall 15
      { location: "Store B", productSku: "WIDGET", productName: "Widget", onHand: 10 }, // shortfall 5
    ];
    const thresholds = new Map([
      ["WIDGET::Store A", { minimumBeforeReorder: 10, reorderQuantity: 5 }],
      ["WIDGET::Store B", { minimumBeforeReorder: 10, reorderQuantity: 5 }],
    ]);

    const lines = buildReplenishLines(rows, thresholds, "Main Warehouse");

    // Store A (shortfall 15) served first, capped to whatever's left of the 12 units; Store B (shortfall 5) gets nothing since source is exhausted.
    expect(lines).toEqual([{ productSku: "WIDGET", productName: "Widget", fromLocation: "Main Warehouse", toLocation: "Store A", quantity: 12, capped: true }]);
  });

  it("falls back to topping up to minimumBeforeReorder alone when reorderQuantity is 0", () => {
    const rows: AvailabilityRow[] = [
      { location: "Main Warehouse", productSku: "WIDGET", productName: "Widget", onHand: 100 },
      { location: "Store A", productSku: "WIDGET", productName: "Widget", onHand: 2 },
    ];
    const thresholds = new Map([["WIDGET::Store A", { minimumBeforeReorder: 10, reorderQuantity: 0 }]]);

    const lines = buildReplenishLines(rows, thresholds, "Main Warehouse");
    expect(lines[0].quantity).toBe(8); // target = 10 + 0 = 10; shortfall = 8
  });

  it("never proposes the chosen source location as a destination, even if it's also below its own resolved threshold", () => {
    const rows: AvailabilityRow[] = [{ location: "Main Warehouse", productSku: "WIDGET", productName: "Widget", onHand: 1 }];
    const thresholds = new Map([["WIDGET::Main Warehouse", { minimumBeforeReorder: 10, reorderQuantity: 5 }]]);

    const lines = buildReplenishLines(rows, thresholds, "Main Warehouse");
    expect(lines).toEqual([]);
  });

  it("a (product, location) pair with no resolved threshold at all is never proposed", () => {
    const rows: AvailabilityRow[] = [
      { location: "Main Warehouse", productSku: "WIDGET", productName: "Widget", onHand: 100 },
      { location: "Store A", productSku: "WIDGET", productName: "Widget", onHand: 0 },
    ];
    const lines = buildReplenishLines(rows, new Map(), "Main Warehouse");
    expect(lines).toEqual([]);
  });
});
