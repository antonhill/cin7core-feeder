import { describe, expect, it } from "vitest";
import {
  ORDER_FULFILLMENT_EXPORT_COLUMNS,
  DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS,
  resolveOrderFulfillmentExportColumns,
  isOrderFulfillmentExportColumnKey,
} from "@/reports/order-fulfillment-export-columns";

describe("resolveOrderFulfillmentExportColumns", () => {
  it("falls back to the default column set when no keys are given", () => {
    const resolved = resolveOrderFulfillmentExportColumns(undefined);
    expect(resolved.map((c) => c.key)).toEqual(DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS);
  });

  it("falls back to the default column set for an empty selection", () => {
    const resolved = resolveOrderFulfillmentExportColumns([]);
    expect(resolved.map((c) => c.key)).toEqual(DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS);
  });

  it("resolves a custom selection in canonical registry order, not the requested order", () => {
    const resolved = resolveOrderFulfillmentExportColumns(["paid_amount", "order_number", "total_invoiced_qty"]);
    expect(resolved.map((c) => c.key)).toEqual(["order_number", "total_invoiced_qty", "paid_amount"]);
  });

  it("drops unknown/stale keys rather than throwing, falling back to defaults if nothing valid remains", () => {
    const resolved = resolveOrderFulfillmentExportColumns(["not_a_real_column", "also_fake"]);
    expect(resolved.map((c) => c.key)).toEqual(DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS);
  });

  it("keeps only the known keys when a selection mixes valid and stale ones", () => {
    const resolved = resolveOrderFulfillmentExportColumns(["order_number", "not_a_real_column"]);
    expect(resolved.map((c) => c.key)).toEqual(["order_number"]);
  });
});

describe("isOrderFulfillmentExportColumnKey", () => {
  it("recognizes every registered column key", () => {
    for (const col of ORDER_FULFILLMENT_EXPORT_COLUMNS) {
      expect(isOrderFulfillmentExportColumnKey(col.key)).toBe(true);
    }
  });

  it("rejects an unregistered key", () => {
    expect(isOrderFulfillmentExportColumnKey("nonexistent")).toBe(false);
  });
});
