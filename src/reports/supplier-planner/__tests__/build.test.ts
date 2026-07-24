import { describe, expect, it } from "vitest";
import { buildSupplierPlanLines, groupLinesBySupplier, type SupplierPlanProductInput } from "@/reports/supplier-planner/build";

function product(overrides: Partial<SupplierPlanProductInput> = {}): SupplierPlanProductInput {
  return {
    sku: "SKU1",
    name: "Product One",
    suppliers: [
      {
        supplierId: "sup-1",
        supplierName: "3 Diamonds Transport (Pty) Ltd",
        cost: 600,
        currency: "USD",
        options: [{ locationId: null, locationName: null, reorderQuantity: 500, lead: 10, safety: 20, minimumToReorder: 500 }],
      },
    ],
    ...overrides,
  };
}

describe("buildSupplierPlanLines", () => {
  it("computes threshold from velocity × (lead + safety) × buffer, and flags needsReorder when on-hand is at or below it", () => {
    const velocityBySku = new Map([["SKU1", 300]]); // 300 units sold over the period
    const onHandBySku = new Map([["SKU1", 50]]);
    const lines = buildSupplierPlanLines([product()], velocityBySku, onHandBySku, { bufferPercent: 0, periodDays: 30 });

    expect(lines).toHaveLength(1);
    // dailyRate = 300/30 = 10; leadTimeDemand = 10 * (10+20) * 1.0 = 300; MinimumToReorder=500 wins as the floor
    expect(lines[0].threshold).toBe(500);
    expect(lines[0].needsReorder).toBe(true);
  });

  it("applies buffer % on top of the velocity-based lead-time demand", () => {
    const velocityBySku = new Map([["SKU1", 300]]);
    const onHandBySku = new Map([["SKU1", 1000]]); // plenty of stock, so MinimumToReorder floor isn't the binding constraint here
    const lines = buildSupplierPlanLines(
      [product({ suppliers: [{ supplierId: "sup-1", supplierName: "S", cost: null, currency: null, options: [{ locationId: null, locationName: null, reorderQuantity: 0, lead: 10, safety: 20, minimumToReorder: 0 }] }] })],
      velocityBySku,
      onHandBySku,
      { bufferPercent: 20, periodDays: 30 }
    );
    // dailyRate = 10; leadTimeDemand = 10 * 30 * 1.2 = 360
    expect(lines[0].threshold).toBe(360);
  });

  it("uses the supplier's own MinimumToReorder as a floor under the velocity-based number — never overridden by it", () => {
    const velocityBySku = new Map([["SKU1", 0]]); // zero velocity — leadTimeDemand would be 0
    const onHandBySku = new Map([["SKU1", 100]]);
    const lines = buildSupplierPlanLines(
      [product({ suppliers: [{ supplierId: "sup-1", supplierName: "S", cost: null, currency: null, options: [{ locationId: null, locationName: null, reorderQuantity: 0, lead: 5, safety: 5, minimumToReorder: 200 }] }] })],
      velocityBySku,
      onHandBySku,
      { bufferPercent: 10, periodDays: 30 }
    );
    expect(lines[0].threshold).toBe(200);
    expect(lines[0].needsReorder).toBe(true);
  });

  it("skips an entry with no Lead configured — nothing to plan a lead time around", () => {
    const lines = buildSupplierPlanLines(
      [product({ suppliers: [{ supplierId: "sup-1", supplierName: "S", cost: null, currency: null, options: [{ locationId: null, locationName: null, reorderQuantity: 0, lead: null, safety: null, minimumToReorder: null }] }] })],
      new Map(),
      new Map(),
      { bufferPercent: 0, periodDays: 30 }
    );
    expect(lines).toHaveLength(0);
  });

  it("suggestedQty is the greater of the supplier's own ReorderQuantity and the actual shortfall to threshold", () => {
    const velocityBySku = new Map([["SKU1", 300]]);
    const onHandBySku = new Map([["SKU1", 50]]);
    // threshold=500 (MinimumToReorder floor), onHand=50 -> shortfall=450, ReorderQuantity=500 -> suggestedQty=max(500,450)=500
    const lines = buildSupplierPlanLines([product()], velocityBySku, onHandBySku, { bufferPercent: 0, periodDays: 30 });
    expect(lines[0].suggestedQty).toBe(500);
  });

  it("collapses Cin7's auto-copied per-location entries to just the default, only surfacing a location that genuinely diverges", () => {
    const options = [
      { locationId: null, locationName: null, reorderQuantity: 500, lead: 10, safety: 20, minimumToReorder: 500 },
      { locationId: "loc-copy", locationName: "Copy Location", reorderQuantity: 500, lead: 10, safety: 20, minimumToReorder: null }, // exact copy of default
      { locationId: "loc-custom", locationName: "Custom Location", reorderQuantity: 200, lead: 3, safety: 5, minimumToReorder: null }, // genuinely different
    ];
    const lines = buildSupplierPlanLines(
      [product({ suppliers: [{ supplierId: "sup-1", supplierName: "S", cost: null, currency: null, options }] })],
      new Map([["SKU1", 0]]),
      new Map([["SKU1", 0]]),
      { bufferPercent: 0, periodDays: 30 }
    );
    expect(lines).toHaveLength(2); // default + the one genuinely-diverging location, NOT the exact copy
    expect(lines.map((l) => l.locationName)).toEqual([null, "Custom Location"]);
  });

  it("defaults onOrder/moverCategory/status when no extra data is supplied for a SKU", () => {
    const velocityBySku = new Map([["SKU1", 300]]);
    const onHandBySku = new Map([["SKU1", 50]]);
    const lines = buildSupplierPlanLines([product()], velocityBySku, onHandBySku, { bufferPercent: 0, periodDays: 30 });
    expect(lines[0].onOrder).toBe(0);
    expect(lines[0].moverCategory).toBe("No movement");
    expect(lines[0].status).toBe("Healthy");
  });

  it("passes through onOrder/moverCategory/status from the same per-SKU data the Reorder Report already computes", () => {
    const velocityBySku = new Map([["SKU1", 300]]);
    const onHandBySku = new Map([["SKU1", 50]]);
    const extraBySku = new Map([["SKU1", { onOrder: 120, moverCategory: "Fast" as const, status: "Stockout risk" as const }]]);
    const lines = buildSupplierPlanLines([product()], velocityBySku, onHandBySku, { bufferPercent: 0, periodDays: 30 }, extraBySku);
    expect(lines[0].onOrder).toBe(120);
    expect(lines[0].moverCategory).toBe("Fast");
    expect(lines[0].status).toBe("Stockout risk");
  });

  it("groups lines by supplier name", () => {
    const products: SupplierPlanProductInput[] = [
      product({ sku: "SKU1" }),
      product({
        sku: "SKU2",
        suppliers: [{ supplierId: "sup-2", supplierName: "ABC Suppliers", cost: 500, currency: "ZAR", options: [{ locationId: null, locationName: null, reorderQuantity: 100, lead: 5, safety: 5, minimumToReorder: 100 }] }],
      }),
    ];
    const lines = buildSupplierPlanLines(products, new Map(), new Map(), { bufferPercent: 0, periodDays: 30 });
    const grouped = groupLinesBySupplier(lines);
    expect([...grouped.keys()]).toEqual(["3 Diamonds Transport (Pty) Ltd", "ABC Suppliers"]);
    expect(grouped.get("3 Diamonds Transport (Pty) Ltd")).toHaveLength(1);
  });
});
