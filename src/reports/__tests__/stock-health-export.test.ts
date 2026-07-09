import { describe, expect, it } from "vitest";
import { buildStockHealthSheet } from "@/reports/stock-health-export";
import type { StockHealthRow } from "@/reports/query";

function row(overrides: Partial<StockHealthRow>): StockHealthRow {
  return {
    product_sku: "SKU-1",
    product_name: "Widget",
    on_hand: 0,
    available: 0,
    stock_value: 0,
    total_out: 0,
    days_of_cover: null,
    mover_category: "No movement",
    status: "Healthy",
    ...overrides,
  };
}

describe("buildStockHealthSheet", () => {
  it("builds one header row plus one row per product", () => {
    const sheet = buildStockHealthSheet([
      row({
        product_sku: "SKU-1",
        product_name: "Widget",
        on_hand: 88,
        available: 22,
        stock_value: 20910.03,
        total_out: 30,
        days_of_cover: 8.8,
        mover_category: "Fast",
        status: "Healthy",
      }),
    ]);

    expect(sheet.headerRowCount).toBe(1);
    expect(sheet.merges).toEqual([]);
    expect(sheet.data).toEqual([
      ["Product", "SKU", "On Hand", "Available", "Stock Value", "Total Out", "Days of Cover", "Mover Category", "Status"],
      ["Widget", "SKU-1", 88, 22, 20910.03, 30, 8.8, "Fast", "Healthy"],
    ]);
  });

  it("falls back to the SKU as the product name and blanks a null days-of-cover", () => {
    const sheet = buildStockHealthSheet([row({ product_sku: "SKU-2", product_name: null, days_of_cover: null })]);
    expect(sheet.data[1]).toEqual(["SKU-2", "SKU-2", 0, 0, 0, 0, "", "No movement", "Healthy"]);
  });
});
