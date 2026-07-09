import { describe, expect, it } from "vitest";
import { buildInventoryMovementSheet } from "@/reports/inventory-movement-export";
import type { InventoryMovementRow } from "@/reports/query";

function row(overrides: Partial<InventoryMovementRow>): InventoryMovementRow {
  return {
    product_sku: "SKU-1",
    product_name: "Widget",
    qty_in_purchases: 0,
    qty_in_assemblies: 0,
    qty_out_sales: 0,
    qty_out_consumption: 0,
    total_in: 0,
    total_out: 0,
    net_change: 0,
    mover_category: "No movement",
    ...overrides,
  };
}

describe("buildInventoryMovementSheet", () => {
  it("builds one header row plus one row per product, in column order", () => {
    const sheet = buildInventoryMovementSheet([
      row({
        product_sku: "SKU-1",
        product_name: "Widget",
        qty_in_purchases: 10,
        qty_in_assemblies: 5,
        qty_out_sales: 8,
        qty_out_consumption: 2,
        total_in: 15,
        total_out: 10,
        net_change: 5,
        mover_category: "Fast",
      }),
    ]);

    expect(sheet.headerRowCount).toBe(1);
    expect(sheet.merges).toEqual([]);
    expect(sheet.data).toEqual([
      ["Product", "SKU", "Purchased In", "Assembly In", "Total In", "Sold Out", "Consumed Out", "Total Out", "Net Change", "Mover Category"],
      ["Widget", "SKU-1", 10, 5, 15, 8, 2, 10, 5, "Fast"],
    ]);
  });

  it("falls back to the SKU as the product name when it's null", () => {
    const sheet = buildInventoryMovementSheet([row({ product_sku: "SKU-2", product_name: null })]);
    expect(sheet.data[1][0]).toBe("SKU-2");
  });
});
