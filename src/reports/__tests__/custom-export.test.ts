import { describe, expect, it } from "vitest";
import { buildCustomReportSheet } from "@/reports/custom-export";
import type { CustomReportResult } from "@/reports/custom/aggregate";

describe("buildCustomReportSheet", () => {
  it("builds a dynamic header from the chosen labels, one row per group, and a Total row", () => {
    const result: CustomReportResult = {
      rows: [
        { dimensionValues: ["Widget"], measureValues: [5, 250] },
        { dimensionValues: ["Gadget"], measureValues: [1, 50] },
      ],
      totals: [6, 300],
    };

    const sheet = buildCustomReportSheet(["Product"], ["Qty", "Revenue"], result);

    expect(sheet.headerRowCount).toBe(1);
    expect(sheet.merges).toEqual([]);
    expect(sheet.data).toEqual([
      ["Product", "Qty", "Revenue"],
      ["Widget", 5, 250],
      ["Gadget", 1, 50],
      ["Total", 6, 300],
    ]);
  });

  it("puts the Total label first when there are no dimension columns", () => {
    const result: CustomReportResult = { rows: [{ dimensionValues: [], measureValues: [42] }], totals: [42] };
    const sheet = buildCustomReportSheet([], ["Qty"], result);
    expect(sheet.data).toEqual([["Qty"], [42], ["Total", 42]]);
  });

  it("pads the Total row's extra dimension columns with blanks when there's more than one", () => {
    const result: CustomReportResult = { rows: [{ dimensionValues: ["Widget", "Cat1"], measureValues: [5] }], totals: [5] };
    const sheet = buildCustomReportSheet(["Product", "Category"], ["Qty"], result);
    expect(sheet.data).toEqual([
      ["Product", "Category", "Qty"],
      ["Widget", "Cat1", 5],
      ["Total", "", 5],
    ]);
  });

  it("renders a null measure value (e.g. Margin % with zero revenue) as a blank cell, not 0", () => {
    const result: CustomReportResult = { rows: [{ dimensionValues: ["Widget"], measureValues: [null] }], totals: [null] };
    const sheet = buildCustomReportSheet(["Product"], ["Margin %"], result);
    expect(sheet.data).toEqual([
      ["Product", "Margin %"],
      ["Widget", ""],
      ["Total", ""],
    ]);
  });
});
