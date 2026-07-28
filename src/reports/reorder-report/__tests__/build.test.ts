import { describe, expect, it } from "vitest";
import { buildReorderReportSupplierLines } from "../build";
import type { ReorderReportRow } from "@/reports/query";
import type { PendingPurchaseOrderLookup, SupplierPlanOptionInput, SupplierPlanProductInput } from "@/reports/supplier-planner/build";

const EMPTY_PENDING: PendingPurchaseOrderLookup = { byFullKey: new Map(), bySkuSupplier: new Map() };

function makeRow(overrides: Partial<ReorderReportRow> = {}): ReorderReportRow {
  return {
    product_sku: "SKU-1",
    product_name: "Widget",
    on_hand: 10,
    available: 10,
    on_order: 0,
    avg_unit_cost: 5,
    total_out: 50,
    weeks_of_cover: 2,
    reorder_threshold: 50,
    needs_reorder: true,
    mover_category: "Fast",
    status: "Stockout risk",
    ...overrides,
  };
}

function makeOption(overrides: Partial<SupplierPlanOptionInput> = {}): SupplierPlanOptionInput {
  return { locationId: null, locationName: null, reorderQuantity: 0, lead: 10, safety: 5, minimumToReorder: null, ...overrides };
}

function makeProduct(overrides: Partial<SupplierPlanProductInput> = {}): SupplierPlanProductInput {
  return {
    productId: "prod-1",
    sku: "SKU-1",
    name: "Widget",
    category: "Widgets",
    brand: "Acme",
    suppliers: [{ supplierId: "sup-1", supplierName: "Acme Supply", cost: 12.5, currency: "ZAR", options: [makeOption()] }],
    ...overrides,
  };
}

describe("buildReorderReportSupplierLines", () => {
  it("suggests the shortfall to threshold when it exceeds the supplier's MOQ", () => {
    const lines = buildReorderReportSupplierLines([makeRow({ on_hand: 10, on_order: 0, reorder_threshold: 50 })], [makeProduct()], EMPTY_PENDING);
    expect(lines).toHaveLength(1);
    expect(lines[0].suggestedQty).toBe(40); // 50 - 10 - 0
    expect(lines[0].threshold).toBe(50);
  });

  it("floors suggestedQty at the supplier's MOQ (MinimumToReorder) when the shortfall is smaller", () => {
    const product = makeProduct({
      suppliers: [{ supplierId: "sup-1", supplierName: "Acme Supply", cost: 12.5, currency: "ZAR", options: [makeOption({ minimumToReorder: 100 })] }],
    });
    const lines = buildReorderReportSupplierLines([makeRow({ on_hand: 40, on_order: 0, reorder_threshold: 50 })], [product], EMPTY_PENDING);
    expect(lines[0].suggestedQty).toBe(100); // shortfall is only 10, MOQ wins
  });

  it("nets off on_order as well as on_hand, not just on_hand alone", () => {
    const lines = buildReorderReportSupplierLines([makeRow({ on_hand: 10, on_order: 30, reorder_threshold: 50 })], [makeProduct()], EMPTY_PENDING);
    expect(lines[0].suggestedQty).toBe(10); // 50 - 10 - 30
  });

  it("clamps a negative shortfall to 0 rather than a negative suggestedQty", () => {
    const lines = buildReorderReportSupplierLines([makeRow({ on_hand: 200, on_order: 0, reorder_threshold: 50 })], [makeProduct()], EMPTY_PENDING);
    expect(lines[0].suggestedQty).toBe(0);
  });

  it("fans out one line per supplier for a SKU with multiple suppliers, sharing the same onHand/onOrder/threshold", () => {
    const product = makeProduct({
      suppliers: [
        { supplierId: "sup-1", supplierName: "Acme Supply", cost: 12.5, currency: "ZAR", options: [makeOption({ minimumToReorder: 5 })] },
        { supplierId: "sup-2", supplierName: "Beta Supply", cost: 9, currency: "USD", options: [makeOption({ minimumToReorder: 200 })] },
      ],
    });
    const lines = buildReorderReportSupplierLines([makeRow({ on_hand: 10, on_order: 0, reorder_threshold: 50 })], [product], EMPTY_PENDING);
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => l.supplierName).sort()).toEqual(["Acme Supply", "Beta Supply"]);
    expect(lines.every((l) => l.onHand === 10 && l.onOrder === 0 && l.threshold === 50)).toBe(true);
    expect(lines.find((l) => l.supplierName === "Acme Supply")?.suggestedQty).toBe(40); // shortfall wins
    expect(lines.find((l) => l.supplierName === "Beta Supply")?.suggestedQty).toBe(200); // MOQ wins
  });

  it("skips a product with no matching reorder-report row", () => {
    const lines = buildReorderReportSupplierLines([makeRow({ product_sku: "SKU-OTHER" })], [makeProduct()], EMPTY_PENDING);
    expect(lines).toHaveLength(0);
  });

  it("defaults MOQ to 0 when a supplier link has no configured options at all", () => {
    const product = makeProduct({ suppliers: [{ supplierId: "sup-1", supplierName: "Acme Supply", cost: null, currency: null, options: [] }] });
    const lines = buildReorderReportSupplierLines([makeRow({ on_hand: 45, on_order: 0, reorder_threshold: 50 })], [product], EMPTY_PENDING);
    expect(lines[0].suggestedQty).toBe(5); // no MOQ to floor against, just the shortfall
  });

  it("always sets lead/safety/isImportSupplier/isUnconfigured neutral and locationId/locationName null — this report has no lead-time, import-floor, or location-fan-out concept", () => {
    const lines = buildReorderReportSupplierLines([makeRow()], [makeProduct()], EMPTY_PENDING);
    expect(lines[0]).toMatchObject({ lead: 0, safety: 0, isImportSupplier: false, isUnconfigured: false, locationId: null, locationName: null });
  });

  it("wires up a pending purchase order via the sku::supplier key", () => {
    const pending: PendingPurchaseOrderLookup = {
      byFullKey: new Map(),
      bySkuSupplier: new Map([["SKU-1::sup-1", { orderNumber: "PO-9", createdAt: "2026-07-01T00:00:00Z" }]]),
    };
    const lines = buildReorderReportSupplierLines([makeRow()], [makeProduct()], pending);
    expect(lines[0].pendingPurchaseOrder).toEqual({ orderNumber: "PO-9", createdAt: "2026-07-01T00:00:00Z" });
  });

  it("passes through moverCategory/status/needsReorder straight from the report row", () => {
    const lines = buildReorderReportSupplierLines(
      [makeRow({ mover_category: "Slow", status: "Excess", needs_reorder: false })],
      [makeProduct()],
      EMPTY_PENDING
    );
    expect(lines[0]).toMatchObject({ moverCategory: "Slow", status: "Excess", needsReorder: false });
  });
});
