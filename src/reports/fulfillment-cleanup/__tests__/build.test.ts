import { describe, expect, it } from "vitest";
import { buildFulfillmentCleanupLines, type NegativeAvailabilityRow } from "@/reports/fulfillment-cleanup/build";

function row(overrides: Partial<NegativeAvailabilityRow>): NegativeAvailabilityRow {
  return {
    location: "Main Warehouse",
    productSku: "SKU-A",
    productName: "Widget",
    bin: null,
    batchSn: null,
    expiryDate: null,
    onHand: 0,
    available: -5,
    ...overrides,
  };
}

describe("buildFulfillmentCleanupLines", () => {
  it("sets quantity to bring availability back to exactly zero", () => {
    const [line] = buildFulfillmentCleanupLines([row({ available: -7 })], new Map(), "2026-07-10");
    expect(line.quantity).toBe(7);
  });

  it("marks a zero-on-hand line as Zero and fills UnitCost from the average cost map", () => {
    const [line] = buildFulfillmentCleanupLines([row({ productSku: "SKU-A", onHand: 0 })], new Map([["SKU-A", 12.5]]), "2026-07-10");
    expect(line.action).toBe("Zero");
    expect(line.unitCost).toBe(12.5);
  });

  it("marks a line with real on-hand stock as NonZero and leaves UnitCost blank even if a cost is known", () => {
    const [line] = buildFulfillmentCleanupLines([row({ productSku: "SKU-A", onHand: 3 })], new Map([["SKU-A", 12.5]]), "2026-07-10");
    expect(line.action).toBe("NonZero");
    expect(line.unitCost).toBeNull();
  });

  it("leaves UnitCost null on a Zero line when no average cost is on file", () => {
    const [line] = buildFulfillmentCleanupLines([row({ productSku: "SKU-UNKNOWN", onHand: 0 })], new Map(), "2026-07-10");
    expect(line.action).toBe("Zero");
    expect(line.unitCost).toBeNull();
  });

  it("treats negative on_hand the same as zero (Zero action) rather than crashing on an unexpected sign", () => {
    const [line] = buildFulfillmentCleanupLines([row({ onHand: -2 })], new Map(), "2026-07-10");
    expect(line.action).toBe("Zero");
  });

  it("stamps every line with today's date and carries location/bin/batch/expiry through unchanged", () => {
    const [line] = buildFulfillmentCleanupLines(
      [row({ location: "Overflow", bin: "B12", batchSn: "BATCH-1", expiryDate: "2027-01-01" })],
      new Map(),
      "2026-07-10"
    );
    expect(line.receivedDate).toBe("2026-07-10");
    expect(line.location).toBe("Overflow");
    expect(line.bin).toBe("B12");
    expect(line.batchSn).toBe("BATCH-1");
    expect(line.expiryDate).toBe("2027-01-01");
  });

  it("filters out any row that isn't actually negative, defensively", () => {
    const lines = buildFulfillmentCleanupLines([row({ available: 0 }), row({ available: 5 })], new Map(), "2026-07-10");
    expect(lines).toEqual([]);
  });
});
