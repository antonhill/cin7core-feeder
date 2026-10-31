import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildSynth, codes, colOf, sheet } from "@/rwtsa-demo/__tests__/helpers";
import type { FieldSpec } from "@/rwtsa-demo/contracts/fields";
import type { TabContract } from "@/rwtsa-demo/contracts/tabs";
import { parseTab } from "@/rwtsa-demo/workbook/parse-tab";
import type { RawTable } from "@/rwtsa-demo/workbook/read";

/**
 * Regression tests for the independent review of PR #129 (findings 1-8): a workbook that is hollow, partially
 * populated, or silently lossy must NOT be classified as validated.
 */

const emptyAllTabs = (wb: ExcelJS.Workbook, keep: string[] = []) =>
  wb.eachSheet((ws) => {
    if (keep.includes(ws.name)) return;
    for (let i = ws.rowCount; i > 1; i--) ws.spliceRows(i, 1);
  });

const monthCols = () => Array.from({ length: 36 }, (_, i) => i + 2);

describe("P1: empty and partially populated workbooks fail validation", () => {
  it("a workbook with headers only fails: Items, SalesHistory and Stock are errors, every other tab a warning", async () => {
    const r = await buildSynth({}, (wb) => emptyAllTabs(wb));
    expect(r.ok).toBe(false);
    expect(r.dataset).toBeNull();
    const empties = codes(r, "empty_tab");
    expect(empties.filter((f) => f.severity === "error").map((f) => f.tab).sort()).toEqual(["Items", "SalesHistory", "Stock"]);
    expect(empties.filter((f) => f.severity === "warning")).toHaveLength(8);
  });

  it("Items without any stock or sales history fails", async () => {
    const r = await buildSynth({}, (wb) => emptyAllTabs(wb, ["Items"]));
    expect(r.ok).toBe(false);
    expect(codes(r, "empty_tab").filter((f) => f.severity === "error").map((f) => f.tab).sort()).toEqual(["SalesHistory", "Stock"]);
  });

  it("Items and Stock but no sales history fails", async () => {
    const r = await buildSynth({}, (wb) => emptyAllTabs(wb, ["Items", "Stock", "ImportPOs", "Customers", "Quotes", "BOM", "Routing_SMV", "ProductionOrders", "LandedCost", "Payments_FEC"]));
    expect(r.ok).toBe(false);
    expect(codes(r, "empty_tab").filter((f) => f.severity === "error").map((f) => f.tab)).toEqual(["SalesHistory"]);
  });

  it("Stock covering only 3 of 24 Items SKUs fails with a coverage error counting the 21 missing", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Stock");
      for (let i = ws.rowCount; i > 4; i--) ws.spliceRows(i, 1);
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "sku_coverage_missing").map((f) => `${f.tab}:${f.count}`)).toEqual(["Stock:21"]);
  });

  it("SalesHistory covering only 1 of 24 Items SKUs fails with a coverage error counting the 23 missing", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      for (let i = ws.rowCount; i > 2; i--) ws.spliceRows(i, 1);
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "sku_coverage_missing").map((f) => `${f.tab}:${f.count}`)).toEqual(["SalesHistory:23"]);
  });

  it("a complete workbook raises none of the completeness findings", async () => {
    const r = await buildSynth();
    expect(r.ok).toBe(true);
    for (const c of ["empty_tab", "sku_coverage_missing", "sales_series_all_missing", "missing_observation", "negative_value", "style_mismatch", "po_sku_style_mismatch", "duplicate_sheet", "optional_header_absent"]) {
      expect(codes(r, c)).toEqual([]);
    }
  });
});

describe("overall validity is separate from scenario readiness", () => {
  it("a valid workbook whose Customers/Quotes are empty passes with warnings; scenario D is not ready, A/B/C are", async () => {
    const r = await buildSynth({}, (wb) => emptyAllTabs(wb, ["Items", "SalesHistory", "Stock", "ImportPOs", "BOM", "Routing_SMV", "ProductionOrders", "LandedCost", "Payments_FEC"]));
    expect(r.ok).toBe(true);
    expect(codes(r, "empty_tab").map((f) => `${f.tab}:${f.severity}`).sort()).toEqual(["Customers:warning", "Quotes:warning"]);
    const by = Object.fromEntries(r.readiness.map((x) => [x.scenario, x]));
    expect(by.A.ready && by.B.ready && by.C.ready).toBe(true);
    expect(by.D).toMatchObject({ ready: false, missingTabs: ["Customers", "Quotes"] });
    expect(r.dataset!.readiness).toEqual(r.readiness);
  });

  it("an empty ImportPOs tab leaves scenarios A and C not ready but the workbook valid", async () => {
    const r = await buildSynth({}, (wb) => emptyAllTabs(wb, ["Items", "SalesHistory", "Stock", "BOM", "Routing_SMV", "ProductionOrders", "LandedCost", "Payments_FEC", "Customers", "Quotes"]));
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.readiness.map((x) => [x.scenario, x]));
    expect(by.A).toMatchObject({ ready: false, missingTabs: ["ImportPOs"] });
    expect(by.C).toMatchObject({ ready: false, missingTabs: ["ImportPOs"] });
    expect(by.B.ready && by.D.ready).toBe(true);
  });

  it("no scenario is ready when the workbook is invalid", async () => {
    const r = await buildSynth({}, (wb) => emptyAllTabs(wb));
    expect(r.readiness.every((x) => !x.ready)).toBe(true);
  });

  it("a missing core tab remains a missing_tab error", async () => {
    const r = await buildSynth({}, (wb) => wb.removeWorksheet(sheet(wb, "Stock").id));
    expect(r.ok).toBe(false);
    expect(codes(r, "missing_tab").map((f) => f.tab)).toEqual(["Stock"]);
  });
});

describe("absent optional columns are reported without becoming mandatory", () => {
  it("dropping Tender and Min level warns, names the fields, keeps the workbook valid and marks scenario A not ready", async () => {
    const r = await buildSynth({}, (wb) => {
      const it = sheet(wb, "Items");
      it.spliceColumns(colOf(it, "Tender"), 1);
      it.spliceColumns(colOf(sheet(wb, "Items"), "Min level"), 1);
    });
    expect(r.ok).toBe(true);
    const warn = codes(r, "optional_header_absent").filter((f) => f.severity === "warning");
    expect(warn.map((f) => `${f.tab}.${f.field}`).sort()).toEqual(["Items.isTender", "Items.minLevel"]);
    const a = r.readiness.find((x) => x.scenario === "A")!;
    expect(a.ready).toBe(false);
    expect([...a.missingFields].sort()).toEqual(["Items.isTender", "Items.minLevel"]);
    expect(r.readiness.filter((x) => x.scenario !== "A").every((x) => x.ready)).toBe(true);
  });

  it("dropping a non-critical optional column (Description) is only an info finding and affects no scenario", async () => {
    const r = await buildSynth({}, (wb) => {
      const it = sheet(wb, "Items");
      it.spliceColumns(colOf(it, "Description"), 1);
    });
    expect(r.ok).toBe(true);
    const f = codes(r, "optional_header_absent");
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ severity: "info", tab: "Items", fields: ["description"] });
    expect(r.readiness.every((x) => x.ready)).toBe(true);
  });

  it("an absent REQUIRED column is still a hard error", async () => {
    const r = await buildSynth({}, (wb) => {
      const it = sheet(wb, "Items");
      it.spliceColumns(colOf(it, "Standard cost"), 1);
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "missing_header").map((f) => f.field)).toEqual(["standardCost"]);
  });
});

describe("sales history: zero, blank and invalid are three different things", () => {
  it("a complete all-zero series is VALID: zeros stay 0 and nothing is reported missing", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      for (const c of monthCols()) ws.getRow(2).getCell(c).value = 0;
    });
    expect(r.ok).toBe(true);
    const sku = r.dataset!.tables.salesHistory[0].sku;
    const series = r.dataset!.tables.salesHistory.filter((p) => p.sku === sku);
    expect(series).toHaveLength(36);
    expect(series.every((p) => p.qty === 0)).toBe(true);
    expect(codes(r, "missing_observation")).toEqual([]);
    expect(r.dataset!.reconciliation.totals.salesMissingObservations).toBe(0);
  });

  it("a workbook where EVERY sales cell is an explicit zero is valid", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      for (let row = 2; row <= ws.rowCount; row++) for (const c of monthCols()) ws.getRow(row).getCell(c).value = 0;
    });
    expect(r.ok).toBe(true);
    expect(r.dataset!.reconciliation.totals.salesAllMonths).toBe(0);
    expect(r.dataset!.reconciliation.totals.salesMissingObservations).toBe(0);
  });

  it("a fully blank series for a SKU is an error (no demand history at all), not an all-zero series", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      for (const c of monthCols()) ws.getRow(3).getCell(c).value = null;
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "sales_series_all_missing")).toMatchObject([{ severity: "error", tab: "SalesHistory", count: 1, rows: [3] }]);
  });

  it("when every SKU's series is blank the workbook fails for all of them", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      for (let row = 2; row <= ws.rowCount; row++) for (const c of monthCols()) ws.getRow(row).getCell(c).value = null;
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "sales_series_all_missing")[0].count).toBe(24);
  });

  it("mixed observations: blanks become null (counted, never 0), explicit zeros stay 0, and the control totals exclude blanks", async () => {
    const base = await buildSynth();
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      for (const c of [5, 6, 7]) ws.getRow(2).getCell(c).value = null; // 3 blanks in row 2
      for (const c of [10, 11]) ws.getRow(3).getCell(c).value = null; // 2 blanks in row 3
      ws.getRow(4).getCell(8).value = 0; // an explicit zero
    });
    expect(r.ok).toBe(true);
    expect(codes(r, "missing_observation")).toMatchObject([{ severity: "warning", tab: "SalesHistory", count: 5, rows: [2, 3] }]);
    const pts = r.dataset!.tables.salesHistory;
    const sku2 = pts.filter((p) => p.sku === pts[0].sku);
    expect(sku2.filter((p) => p.qty === null)).toHaveLength(3);
    expect(sku2.filter((p) => p.qty === 0)).toHaveLength(0);
    const zeroRowSku = r.dataset!.tables.salesHistory.filter((p) => p.qty === 0);
    expect(zeroRowSku).toHaveLength(1);
    expect(r.dataset!.reconciliation.totals.salesMissingObservations).toBe(5);
    // blanks and zeros contribute nothing to the sums, and are distinguishable in the content hash
    expect(r.dataset!.reconciliation.totals.salesAllMonths).toBeLessThan(base.dataset!.reconciliation.totals.salesAllMonths);
    const zeroed = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      for (const c of [5, 6, 7]) ws.getRow(2).getCell(c).value = 0;
      for (const c of [10, 11]) ws.getRow(3).getCell(c).value = 0;
      ws.getRow(4).getCell(8).value = 0;
    });
    expect(zeroed.dataset!.reconciliation.controlHash).not.toBe(r.dataset!.reconciliation.controlHash);
  });

  it("an invalid value in a month cell is a validation error, not a blank or a zero", async () => {
    const r = await buildSynth({}, (wb) => {
      sheet(wb, "SalesHistory").getRow(2).getCell(5).value = "n/a";
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "invalid_cell").map((f) => `${f.field}:${f.reason}`)).toEqual(["month:number_format"]);
  });
});

describe("negative quantities and costs", () => {
  it("negative stock is an ERROR", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Stock");
      ws.getRow(2).getCell(colOf(ws, "JHB")).value = -500;
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "negative_value")).toMatchObject([{ severity: "error", tab: "Stock", field: "jhb", count: 1, rows: [2] }]);
  });

  it("a negative sales cell (a credit note) is a WARNING; the data stays usable", async () => {
    const r = await buildSynth({}, (wb) => {
      sheet(wb, "SalesHistory").getRow(2).getCell(5).value = -3.5;
    });
    expect(r.ok).toBe(true);
    expect(codes(r, "negative_value").map((f) => `${f.tab}.${f.field}:${f.severity}`)).toEqual(["SalesHistory.month:warning"]);
  });

  const negativeInputs: [string, string, string][] = [
    ["Items", "Standard cost", "standardCost"],
    ["Items", "Standard sell price", "standardSellPrice"],
    ["BOM", "Qty per unit", "qtyPerUnit"],
    ["BOM", "Unit cost", "unitCost"],
    ["Routing_SMV", "SMV", "smv"],
    ["Routing_SMV", "Cost per minute", "costPerMinute"],
    ["ProductionOrders", "Planned minutes", "plannedMinutes"],
    ["ProductionOrders", "Actual minutes", "actualMinutes"],
    ["ProductionOrders", "Actual fabric (m)", "actualFabricM"],
    ["ProductionOrders", "Planned price", "standardPrice"],
    ["ImportPOs", "Qty", "qty"],
    ["ImportPOs", "Unit price USD", "unitPriceUsd"],
    ["LandedCost", "CBM", "cbm"],
    ["LandedCost", "FOB USD", "fobUsd"],
    ["Payments_FEC", "USD amount", "usdAmount"],
    ["Quotes", "Value", "value"],
  ];
  for (const [tab, header, field] of negativeInputs) {
    it(`a negative ${tab}.${field} (inherently non-negative) is an ERROR, while zero stays valid`, async () => {
      const neg = await buildSynth({}, (wb) => {
        const ws = sheet(wb, tab);
        ws.getRow(2).getCell(colOf(ws, header)).value = -1;
      });
      expect(neg.ok).toBe(false);
      expect(codes(neg, "negative_value")).toMatchObject([{ severity: "error", tab, field, count: 1 }]);
      const zero = await buildSynth({}, (wb) => {
        const ws = sheet(wb, tab);
        ws.getRow(2).getCell(colOf(ws, header)).value = 0;
      });
      expect(codes(zero, "negative_value")).toEqual([]);
    });
  }

  it("signed-by-nature fields explicitly permit negatives: variance columns and the file's own Available", async () => {
    const r = await buildSynth({}, (wb) => {
      const po = sheet(wb, "ProductionOrders");
      po.getRow(2).getCell(colOf(po, "Usage variance")).value = -12.5;
      po.getRow(2).getCell(colOf(po, "Price variance")).value = -3;
      const st = sheet(wb, "Stock");
      st.getRow(2).getCell(colOf(st, "Available")).value = -40; // over-committed
    });
    expect(codes(r, "negative_value")).toEqual([]);
    expect(r.ok).toBe(true); // (the Available disagreement itself is the separate, already-tested warning)
  });

  it("a contract that explicitly sets allowNegative reports nothing (the only way a negative is legitimate)", () => {
    const make = (allowNegative: boolean): TabContract => ({
      tab: "Items",
      naturalKey: ["k"],
      fields: [
        { key: "k", headers: ["K"], kind: "str", required: true },
        { key: "adj", headers: ["Adj"], kind: "num", required: false, ...(allowNegative ? { allowNegative: true } : {}) } satisfies FieldSpec,
      ],
    });
    const raw: RawTable = { tab: "Items", headers: ["K", "Adj"], rowNumbers: [2], rows: [["a", -4]] };
    expect(parseTab(make(true), raw).findings.filter((f) => f.code === "negative_value")).toEqual([]);
    expect(parseTab(make(false), raw).findings.filter((f) => f.code === "negative_value")).toHaveLength(1);
  });
});

describe("style consistency", () => {
  it("a Stock row whose style disagrees with its Items SKU's style is an error", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Stock");
      ws.getRow(2).getCell(colOf(ws, "Style code")).value = "SYN-VEST-B"; // SKU 2 belongs to SYN-VEST-A
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "style_mismatch")).toMatchObject([{ severity: "error", tab: "Stock", field: "styleCode", count: 1, rows: [2] }]);
  });

  it("a PO line naming both a SKU and a style must agree with Items; a consistent line, and a style-only line, are fine", async () => {
    const consistent = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "ImportPOs");
      ws.getRow(2).getCell(colOf(ws, "SKU")).value = "SYN-VEST-A-M";
      ws.getRow(2).getCell(colOf(ws, "Style code")).value = "SYN-VEST-A";
    });
    expect(consistent.ok).toBe(true);
    expect(codes(consistent, "po_sku_style_mismatch")).toEqual([]);

    const conflicting = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "ImportPOs");
      ws.getRow(2).getCell(colOf(ws, "SKU")).value = "SYN-VEST-A-M";
      ws.getRow(2).getCell(colOf(ws, "Style code")).value = "SYN-VEST-B";
    });
    expect(conflicting.ok).toBe(false);
    expect(codes(conflicting, "po_sku_style_mismatch")).toMatchObject([{ severity: "error", tab: "ImportPOs", count: 1, rows: [2] }]);
  });
});

describe("duplicate worksheets", () => {
  it("two sheets that normalise to the same expected tab name are an error, not silently the first", async () => {
    const r = await buildSynth({}, (wb) => {
      wb.addWorksheet("items ").addRow(["x"]);
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "duplicate_sheet")).toMatchObject([{ severity: "error", tab: "Items", count: 1 }]);
    expect(codes(r, "unknown_tab")).toEqual([]); // reported as a duplicate, not mislabelled unknown
  });

  it("an unrelated extra sheet is still only an unknown-tab warning", async () => {
    const r = await buildSynth({}, (wb) => {
      wb.addWorksheet("Notes").addRow(["x"]);
    });
    expect(r.ok).toBe(true);
    expect(codes(r, "duplicate_sheet")).toEqual([]);
    expect(codes(r, "unknown_tab")).toHaveLength(1);
  });
});
