import { describe, expect, it } from "vitest";
import { aggregateCustomReport, type DimensionDef, type MeasureDef } from "@/reports/custom/aggregate";

interface Row {
  sku: string;
  name: string;
  category: string;
  qty: number;
  revenue: number;
  profit: number;
}

const rows: Row[] = [
  { sku: "A", name: "Widget", category: "Cat1", qty: 2, revenue: 100, profit: 40 },
  { sku: "A", name: "Widget", category: "Cat1", qty: 3, revenue: 150, profit: 60 },
  { sku: "B", name: "Gadget", category: "Cat2", qty: 1, revenue: 50, profit: 10 },
];

const productDim: DimensionDef<Row> = { key: "product", label: "Product", getGroupKey: (r) => r.sku, getDisplayValue: (r) => r.name };
const categoryDim: DimensionDef<Row> = { key: "category", label: "Category", getGroupKey: (r) => r.category };
const qtyMeasure: MeasureDef<Row> = { key: "qty", label: "Qty", getValue: (r) => r.qty };
const revenueMeasure: MeasureDef<Row> = { key: "revenue", label: "Revenue", getValue: (r) => r.revenue };
const profitMeasure: MeasureDef<Row> = { key: "profit", label: "Profit", getValue: (r) => r.profit };
const marginMeasure: MeasureDef<Row> = {
  key: "margin_percent",
  label: "Margin %",
  dependsOn: ["revenue", "profit"],
  compute: (sums) => (sums.revenue ? Math.round((sums.profit / sums.revenue) * 10000) / 100 : null),
};
const allMeasures = [qtyMeasure, revenueMeasure, profitMeasure, marginMeasure];

describe("aggregateCustomReport", () => {
  it("groups rows by a single dimension's group key and sums each selected sum measure", () => {
    const result = aggregateCustomReport(rows, [productDim], allMeasures, ["qty", "revenue"]);

    expect(result.rows).toEqual([
      { dimensionValues: ["Widget"], measureValues: [5, 250] },
      { dimensionValues: ["Gadget"], measureValues: [1, 50] },
    ]);
    expect(result.totals).toEqual([6, 300]);
  });

  it("groups by a composite key across multiple dimensions", () => {
    const multiRows: Row[] = [...rows, { sku: "A", name: "Widget", category: "Cat3", qty: 1, revenue: 10, profit: 2 }];
    const result = aggregateCustomReport(multiRows, [productDim, categoryDim], allMeasures, ["qty"]);

    expect(result.rows).toHaveLength(3); // A/Cat1, B/Cat2, A/Cat3 — same SKU in a different category is a distinct group
    const aCat1 = result.rows.find((r) => r.dimensionValues[1] === "Cat1");
    expect(aCat1?.measureValues).toEqual([5]);
  });

  it("groups by SKU (not display name) so two SKUs sharing a name don't merge", () => {
    const clashRows: Row[] = [
      { sku: "A", name: "Same Name", category: "X", qty: 1, revenue: 1, profit: 1 },
      { sku: "B", name: "Same Name", category: "X", qty: 2, revenue: 2, profit: 1 },
    ];
    const result = aggregateCustomReport(clashRows, [productDim], allMeasures, ["qty"]);
    expect(result.rows).toHaveLength(2);
  });

  it("collapses everything into one grand-total row when no dimensions are chosen", () => {
    const result = aggregateCustomReport(rows, [], allMeasures, ["qty", "revenue"]);
    expect(result.rows).toEqual([{ dimensionValues: [], measureValues: [6, 300] }]);
    expect(result.totals).toEqual([6, 300]);
  });

  it("still groups correctly with no measures chosen", () => {
    const result = aggregateCustomReport(rows, [productDim], allMeasures, []);
    expect(result.rows).toEqual([
      { dimensionValues: ["Widget"], measureValues: [] },
      { dimensionValues: ["Gadget"], measureValues: [] },
    ]);
    expect(result.totals).toEqual([]);
  });

  it("returns no rows for an empty input", () => {
    const result = aggregateCustomReport([], [productDim], allMeasures, ["qty"]);
    expect(result.rows).toEqual([]);
    expect(result.totals).toEqual([0]);
  });

  describe("ratio measures (e.g. Margin %)", () => {
    it("computes the ratio from the group's summed dependencies, not by averaging per-row ratios", () => {
      const result = aggregateCustomReport(rows, [productDim], allMeasures, ["margin_percent"]);
      // Widget: revenue 250, profit 100 -> 40%. Gadget: revenue 50, profit 10 -> 20%.
      expect(result.rows).toEqual([
        { dimensionValues: ["Widget"], measureValues: [40] },
        { dimensionValues: ["Gadget"], measureValues: [20] },
      ]);
    });

    it("computes the grand total from the grand-total sums, not from averaging group-level ratios", () => {
      const result = aggregateCustomReport(rows, [productDim], allMeasures, ["margin_percent"]);
      // total revenue 300, total profit 110 -> 36.67%, NOT (40+20)/2 = 30%.
      expect(result.totals).toEqual([36.67]);
    });

    it("resolves a ratio's dependencies even when they aren't themselves selected as output columns", () => {
      const result = aggregateCustomReport(rows, [productDim], allMeasures, ["margin_percent"]);
      expect(result.rows[0].measureValues).toHaveLength(1); // only Margin % shown, Revenue/Profit stay internal
    });

    it("returns null (not 0 or NaN) when the denominator is zero", () => {
      const zeroRevenueRows: Row[] = [{ sku: "A", name: "Widget", category: "Cat1", qty: 1, revenue: 0, profit: 0 }];
      const result = aggregateCustomReport(zeroRevenueRows, [productDim], allMeasures, ["margin_percent"]);
      expect(result.rows[0].measureValues).toEqual([null]);
      expect(result.totals).toEqual([null]);
    });

    it("can be selected alongside its own dependencies as separate columns", () => {
      const result = aggregateCustomReport(rows, [productDim], allMeasures, ["revenue", "profit", "margin_percent"]);
      expect(result.rows[0]).toEqual({ dimensionValues: ["Widget"], measureValues: [250, 100, 40] });
    });
  });
});
