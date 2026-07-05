import { describe, expect, it } from "vitest";
import { buildPivotGrid, type PivotSourceRow } from "@/reports/pivot";

function row(overrides: Partial<PivotSourceRow>): PivotSourceRow {
  return {
    product_sku: "SKU-1",
    product_name: "Widget",
    location: null,
    category_code: null,
    quantity_sold: 1,
    revenue: 0,
    cogs: 0,
    profit: 0,
    ...overrides,
  };
}

describe("buildPivotGrid — location mode", () => {
  it("builds one column per distinct location", () => {
    const rows = [
      row({ product_sku: "A", location: "Main WH", revenue: 100, cogs: 60, profit: 40 }),
      row({ product_sku: "A", location: "Cape Town", revenue: 50, cogs: 30, profit: 20 }),
      row({ product_sku: "B", location: "Main WH", revenue: 200, cogs: 120, profit: 80 }),
    ];

    const grid = buildPivotGrid(rows, "location");

    expect(grid.columns).toEqual([
      { key: "Cape Town", label: "Cape Town" },
      { key: "Main WH", label: "Main WH" },
    ]);
    expect(grid.columnGroups).toBeNull();
  });

  it("carries every metric (qty/revenue/cogs/profit/margin%) per cell, sorts rows by revenue descending, and leaves a missing cell null", () => {
    const rows = [
      row({ product_sku: "A", location: "Main WH", quantity_sold: 2, revenue: 100, cogs: 60, profit: 40 }),
      row({ product_sku: "B", location: "Main WH", quantity_sold: 4, revenue: 200, cogs: 120, profit: 80 }),
      row({ product_sku: "B", location: "Cape Town", quantity_sold: 1, revenue: 50, cogs: 30, profit: 20 }),
    ];

    const grid = buildPivotGrid(rows, "location");

    expect(grid.rows.map((r) => r.productSku)).toEqual(["B", "A"]); // B total revenue 250 > A total 100
    const rowA = grid.rows.find((r) => r.productSku === "A")!;
    expect(rowA.cells["Main WH"]).toEqual({ quantitySold: 2, revenue: 100, cogs: 60, profit: 40, marginPercent: 40 });
    expect(rowA.cells["Cape Town"]).toBeNull(); // A never sold in Cape Town
    expect(rowA.total).toEqual({ quantitySold: 2, revenue: 100, cogs: 60, profit: 40, marginPercent: 40 });
  });

  it("computes column and grand totals across every metric", () => {
    const rows = [
      row({ product_sku: "A", location: "Main WH", quantity_sold: 1, revenue: 100, cogs: 60, profit: 40 }),
      row({ product_sku: "B", location: "Main WH", quantity_sold: 2, revenue: 200, cogs: 120, profit: 80 }),
      row({ product_sku: "B", location: "Cape Town", quantity_sold: 1, revenue: 50, cogs: 30, profit: 20 }),
    ];

    const grid = buildPivotGrid(rows, "location");

    expect(grid.totals["Main WH"]).toEqual({ quantitySold: 3, revenue: 300, cogs: 180, profit: 120, marginPercent: 40 });
    expect(grid.totals["Cape Town"]).toEqual({ quantitySold: 1, revenue: 50, cogs: 30, profit: 20, marginPercent: 40 });
    expect(grid.grandTotal).toEqual({ quantitySold: 4, revenue: 350, cogs: 210, profit: 140, marginPercent: 40 });
  });
});

describe("buildPivotGrid — category mode", () => {
  it("builds one column per distinct category", () => {
    const rows = [row({ category_code: "WIDGETS", revenue: 10, profit: 5 }), row({ category_code: "GADGETS", revenue: 20, profit: 8 })];
    const grid = buildPivotGrid(rows, "category");
    expect(grid.columns.map((c) => c.key).sort()).toEqual(["GADGETS", "WIDGETS"]);
  });
});

describe("buildPivotGrid — both mode (nested)", () => {
  it("builds the full location x category cross-product as columns, with group labels", () => {
    const rows = [
      row({ product_sku: "A", location: "Main WH", category_code: "WIDGETS", quantity_sold: 2, revenue: 100, cogs: 60, profit: 40 }),
      row({ product_sku: "A", location: "Cape Town", category_code: "GADGETS", quantity_sold: 1, revenue: 30, cogs: 20, profit: 10 }),
    ];

    const grid = buildPivotGrid(rows, "both");

    expect(grid.columnGroups).toEqual([
      { label: "Cape Town", span: 2 },
      { label: "Main WH", span: 2 },
    ]);
    expect(grid.columns).toEqual([
      { key: "Cape Town::GADGETS", label: "GADGETS", groupLabel: "Cape Town" },
      { key: "Cape Town::WIDGETS", label: "WIDGETS", groupLabel: "Cape Town" },
      { key: "Main WH::GADGETS", label: "GADGETS", groupLabel: "Main WH" },
      { key: "Main WH::WIDGETS", label: "WIDGETS", groupLabel: "Main WH" },
    ]);

    const rowA = grid.rows[0];
    expect(rowA.cells["Main WH::WIDGETS"]).toEqual({ quantitySold: 2, revenue: 100, cogs: 60, profit: 40, marginPercent: 40 });
    expect(rowA.cells["Cape Town::GADGETS"]).toEqual({ quantitySold: 1, revenue: 30, cogs: 20, profit: 10, marginPercent: 33.33 });
    // Never observed for A — genuine gap, not a missing column.
    expect(rowA.cells["Main WH::GADGETS"]).toBeNull();
    expect(rowA.cells["Cape Town::WIDGETS"]).toBeNull();
  });
});

describe("buildPivotGrid — margin% totals are re-derived, not summed", () => {
  it("computes a row's margin% from summed revenue/profit, not from averaging per-cell margins", () => {
    // Cell 1: revenue 100, profit 10 -> 10% margin. Cell 2: revenue 900, profit 450 -> 50% margin.
    // A naive average of (10% + 50%)/2 = 30% would be wrong; the real combined margin is 460/1000 = 46%.
    const rows = [
      row({ product_sku: "A", location: "Main WH", revenue: 100, cogs: 90, profit: 10 }),
      row({ product_sku: "A", location: "Cape Town", revenue: 900, cogs: 450, profit: 450 }),
    ];

    const grid = buildPivotGrid(rows, "location");

    expect(grid.rows[0].total.marginPercent).toBe(46);
  });

  it("returns null margin% when revenue is zero rather than dividing by zero", () => {
    const rows = [row({ product_sku: "A", location: "Main WH", revenue: 0, cogs: 0, profit: 0 })];
    const grid = buildPivotGrid(rows, "location");
    expect(grid.rows[0].cells["Main WH"]!.marginPercent).toBeNull();
  });
});
