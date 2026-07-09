import { describe, expect, it } from "vitest";
import { aggregateCustomReport, type DimensionDef, type MeasureDef } from "@/reports/custom/aggregate";

interface Row {
  sku: string;
  name: string;
  category: string;
  qty: number;
  revenue: number;
}

const rows: Row[] = [
  { sku: "A", name: "Widget", category: "Cat1", qty: 2, revenue: 100 },
  { sku: "A", name: "Widget", category: "Cat1", qty: 3, revenue: 150 },
  { sku: "B", name: "Gadget", category: "Cat2", qty: 1, revenue: 50 },
];

const productDim: DimensionDef<Row> = { key: "product", label: "Product", getGroupKey: (r) => r.sku, getDisplayValue: (r) => r.name };
const categoryDim: DimensionDef<Row> = { key: "category", label: "Category", getGroupKey: (r) => r.category };
const qtyMeasure: MeasureDef<Row> = { key: "qty", label: "Qty", getValue: (r) => r.qty };
const revenueMeasure: MeasureDef<Row> = { key: "revenue", label: "Revenue", getValue: (r) => r.revenue };

describe("aggregateCustomReport", () => {
  it("groups rows by a single dimension's group key and sums each measure", () => {
    const result = aggregateCustomReport(rows, [productDim], [qtyMeasure, revenueMeasure]);

    expect(result.rows).toEqual([
      { dimensionValues: ["Widget"], measureValues: [5, 250] },
      { dimensionValues: ["Gadget"], measureValues: [1, 50] },
    ]);
    expect(result.totals).toEqual([6, 300]);
  });

  it("groups by a composite key across multiple dimensions", () => {
    const multiRows: Row[] = [...rows, { sku: "A", name: "Widget", category: "Cat3", qty: 1, revenue: 10 }];
    const result = aggregateCustomReport(multiRows, [productDim, categoryDim], [qtyMeasure]);

    expect(result.rows).toHaveLength(3); // A/Cat1, B/Cat2, A/Cat3 — same SKU in a different category is a distinct group
    const aCat1 = result.rows.find((r) => r.dimensionValues[1] === "Cat1");
    expect(aCat1?.measureValues).toEqual([5]);
  });

  it("groups by SKU (not display name) so two SKUs sharing a name don't merge", () => {
    const clashRows: Row[] = [
      { sku: "A", name: "Same Name", category: "X", qty: 1, revenue: 1 },
      { sku: "B", name: "Same Name", category: "X", qty: 2, revenue: 2 },
    ];
    const result = aggregateCustomReport(clashRows, [productDim], [qtyMeasure]);
    expect(result.rows).toHaveLength(2);
  });

  it("collapses everything into one grand-total row when no dimensions are chosen", () => {
    const result = aggregateCustomReport(rows, [], [qtyMeasure, revenueMeasure]);
    expect(result.rows).toEqual([{ dimensionValues: [], measureValues: [6, 300] }]);
    expect(result.totals).toEqual([6, 300]);
  });

  it("still groups correctly with no measures chosen", () => {
    const result = aggregateCustomReport(rows, [productDim], []);
    expect(result.rows).toEqual([
      { dimensionValues: ["Widget"], measureValues: [] },
      { dimensionValues: ["Gadget"], measureValues: [] },
    ]);
    expect(result.totals).toEqual([]);
  });

  it("returns no rows for an empty input", () => {
    const result = aggregateCustomReport([], [productDim], [qtyMeasure]);
    expect(result.rows).toEqual([]);
    expect(result.totals).toEqual([0]);
  });
});
