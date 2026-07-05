import { describe, expect, it } from "vitest";
import { buildFlatReportSheet, buildPivotSheet } from "@/reports/export-xlsx";
import { buildPivotGrid, type PivotSourceRow } from "@/reports/pivot";
import type { ProductSalesReportRow } from "@/reports/query";

function pivotRow(overrides: Partial<PivotSourceRow>): PivotSourceRow {
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

describe("buildFlatReportSheet", () => {
  it("builds one header row plus one row per product", () => {
    const rows: ProductSalesReportRow[] = [
      { product_sku: "SKU-1", product_name: "Widget", category_code: "WIDGETS", quantity_sold: 3, revenue: 100, cogs: 60, profit: 40, margin_percent: 40 },
    ];

    const sheet = buildFlatReportSheet(rows);

    expect(sheet.headerRowCount).toBe(1);
    expect(sheet.merges).toEqual([]);
    expect(sheet.data).toEqual([
      ["Product", "SKU", "Qty sold", "Revenue", "COGS", "Profit", "Margin%"],
      ["Widget", "SKU-1", 3, 100, 60, 40, 40],
    ]);
  });

  it("falls back to the SKU as the product name and blanks a null margin%", () => {
    const rows: ProductSalesReportRow[] = [
      { product_sku: "SKU-2", product_name: null, category_code: null, quantity_sold: 1, revenue: 0, cogs: 0, profit: 0, margin_percent: null },
    ];
    const sheet = buildFlatReportSheet(rows);
    expect(sheet.data[1]).toEqual(["SKU-2", "SKU-2", 1, 0, 0, 0, ""]);
  });
});

describe("buildPivotSheet — single dimension (2 header rows)", () => {
  it("builds a dimension-label row, a metric-label row, then merges spanning each dimension value's 5 metric columns", () => {
    const grid = buildPivotGrid(
      [
        pivotRow({ product_sku: "A", location: "Main WH", quantity_sold: 2, revenue: 100, cogs: 60, profit: 40 }),
        pivotRow({ product_sku: "A", location: "Cape Town", quantity_sold: 1, revenue: 50, cogs: 30, profit: 20 }),
      ],
      "location"
    );

    const sheet = buildPivotSheet(grid);

    expect(sheet.headerRowCount).toBe(2);
    // Row 0: dimension labels — Cape Town at col 1, Main WH at col 6, Total at col 11 (each spans 5).
    expect(sheet.data[0]).toEqual(["", "Cape Town", "", "", "", "", "Main WH", "", "", "", "", "Total", "", "", "", ""]);
    expect(sheet.data[1]).toEqual(["Product", "Qty", "Revenue", "COGS", "Profit", "Margin%", "Qty", "Revenue", "COGS", "Profit", "Margin%", "Qty", "Revenue", "COGS", "Profit", "Margin%"]);
    expect(sheet.merges).toContainEqual({ s: { r: 0, c: 1 }, e: { r: 0, c: 5 } }); // Cape Town block
    expect(sheet.merges).toContainEqual({ s: { r: 0, c: 6 }, e: { r: 0, c: 10 } }); // Main WH block
    expect(sheet.merges).toContainEqual({ s: { r: 0, c: 11 }, e: { r: 0, c: 15 } }); // Total block
  });

  it("writes each product's row with its cell metrics in column order, and a Total footer row", () => {
    const grid = buildPivotGrid([pivotRow({ product_sku: "A", location: "Main WH", quantity_sold: 2, revenue: 100, cogs: 60, profit: 40 })], "location");
    const sheet = buildPivotSheet(grid);

    const productRow = sheet.data[2];
    expect(productRow).toEqual(["Widget", 2, 100, 60, 40, 40, 2, 100, 60, 40, 40]); // Main WH block then Total block

    const footerRow = sheet.data.at(-1)!;
    expect(footerRow[0]).toBe("Total");
  });

  it("blanks out cells for a dimension value a product never sold in — a gap, not a zero", () => {
    const grid = buildPivotGrid(
      [
        pivotRow({ product_sku: "A", product_name: "Widget A", location: "Main WH", revenue: 100, cogs: 60, profit: 40 }),
        pivotRow({ product_sku: "B", product_name: "Widget B", location: "Cape Town", revenue: 50, cogs: 30, profit: 20 }),
      ],
      "location"
    );
    const sheet = buildPivotSheet(grid);
    // Column order is alphabetical: Cape Town (cols 1-5), Main WH (cols 6-10), Total (cols 11-15).
    const rowA = sheet.data.find((row) => row[0] === "Widget A")!;
    expect(rowA.slice(1, 6)).toEqual(["", "", "", "", ""]); // A never sold in Cape Town
    expect(rowA.slice(6, 11)).toEqual([1, 100, 60, 40, 40]); // A's Main WH figures
  });
});

describe("buildPivotSheet — both mode (3 header rows)", () => {
  it("adds a top Location-group row spanning each location's full category x metric width", () => {
    const grid = buildPivotGrid(
      [
        pivotRow({ product_sku: "A", location: "Main WH", category_code: "WIDGETS", revenue: 100, cogs: 60, profit: 40 }),
        pivotRow({ product_sku: "A", location: "Cape Town", category_code: "GADGETS", revenue: 30, cogs: 20, profit: 10 }),
      ],
      "both"
    );

    const sheet = buildPivotSheet(grid);

    expect(sheet.headerRowCount).toBe(3);
    // 2 categories x 2 locations => each location group spans 2 categories * 5 metrics = 10 columns.
    expect(sheet.merges).toContainEqual({ s: { r: 0, c: 1 }, e: { r: 0, c: 10 } });
    expect(sheet.merges).toContainEqual({ s: { r: 0, c: 11 }, e: { r: 0, c: 20 } });
    expect(sheet.data[0][1]).toBe("Cape Town");
    expect(sheet.data[0][11]).toBe("Main WH");
    expect(sheet.data[1]).toEqual(
      expect.arrayContaining(["GADGETS", "WIDGETS"]) // category sub-labels appear in row 1
    );
  });
});
