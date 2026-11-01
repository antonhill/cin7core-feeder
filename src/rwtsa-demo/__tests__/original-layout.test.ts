import { describe, expect, it } from "vitest";
import { buildFrom, codes } from "@/rwtsa-demo/__tests__/helpers";
import { ORIGINAL_SHAPED, originalShapedBuffer } from "@/rwtsa-demo/fixtures/original-shaped";
import { runCosting } from "@/rwtsa-demo/engine/bom-costing";
import { runLandedCost } from "@/rwtsa-demo/engine/landed-cost";
import { runProductionVariance } from "@/rwtsa-demo/engine/production-variance";
import { runQuoteConversion } from "@/rwtsa-demo/engine/quote-conversion";
import { runRedFlag } from "@/rwtsa-demo/engine/red-flag";
import { TAB_NAMES, type TabName } from "@/rwtsa-demo/contracts/tabs";
import type { TabLayoutReport } from "@/rwtsa-demo/workbook/layouts";

/**
 * The advisor's workbook is NOT tabular on five tabs and uses its own header wording on the rest. These tests load a
 * SYNTHETIC workbook with the same structural characteristics DIRECTLY (no reshaping) and check every layout rule.
 */

const load = async (mutate?: Parameters<typeof originalShapedBuffer>[0]) => buildFrom(await originalShapedBuffer(mutate));
const O = ORIGINAL_SHAPED;
const lay = (r: Awaited<ReturnType<typeof load>>) => r.layout as Record<TabName, TabLayoutReport>;
const errors = (r: Awaited<ReturnType<typeof load>>) => r.findings.filter((f) => f.severity === "error").map((f) => `${f.tab}:${f.code}:${f.field ?? ""}`);

describe("the original-shaped workbook loads directly", () => {
  it("builds a dataset with no error findings and no reshaping", async () => {
    const r = await load();
    expect(errors(r)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.dataset).not.toBeNull();
  });
  it("parses every one of the 11 data tabs, and accepts ReadMe as a recognised supplementary sheet", async () => {
    const r = await load();
    const n = r.parsedRowCounts;
    expect(TAB_NAMES.every((t) => (n[t as TabName] ?? 0) > 0)).toBe(true);
    expect(n).toMatchObject({ Items: 10, SalesHistory: 10, Stock: 10, ImportPOs: 4, Routing_SMV: 3, ProductionOrders: 2, LandedCost: 2, Payments_FEC: 3, Customers: 3, Quotes: 4 });
    expect(codes(r, "unknown_tab")).toEqual([]);
    expect(codes(r, "supplementary_sheet")).toHaveLength(1);
    expect(codes(r, "supplementary_sheet")[0]).toMatchObject({ severity: "info", count: 1 });
  });
  it("an unrecognised extra sheet is still reported as unknown", async () => {
    const r = await load((wb) => void wb.addWorksheet("Mystery").addRow(["x"]));
    expect(codes(r, "unknown_tab")).toHaveLength(1);
    expect(codes(r, "supplementary_sheet")).toHaveLength(1);
  });
});

describe("header rows and report-title extraction", () => {
  it("finds the header on row 4 (BOM, Routing_SMV, LandedCost) and row 3 (ProductionOrders, Payments_FEC); tabular tabs use row 1", async () => {
    const r = await load();
    const L = lay(r);
    expect([L.BOM.headerRow, L.Routing_SMV.headerRow, L.LandedCost.headerRow]).toEqual([4, 4, 4]);
    expect([L.ProductionOrders.headerRow, L.Payments_FEC.headerRow]).toEqual([3, 3]);
    expect([L.Items.headerRow, L.ImportPOs.headerRow, L.Quotes.headerRow]).toEqual([1, 1, 1]);
    expect(L.BOM.layout).toBe("report");
    expect(L.Items.layout).toBe("standard");
  });
  it("takes the style from the BOM and Routing titles, and the cost per minute from the routing text line", async () => {
    const d = (await load()).dataset!;
    expect(new Set(d.tables.bom.map((b) => b.styleCode))).toEqual(new Set([O.styleA]));
    expect(d.tables.routing.map((x) => x.styleCode)).toEqual([O.styleA, O.styleA, O.styleA]);
    expect(d.tables.routing.map((x) => x.costPerMinute)).toEqual([O.cpm, O.cpm, O.cpm]);
    expect(d.tables.routing.map((x) => x.smv)).toEqual([2, 3, 3]);
  });
  it("takes the shipment from the landed-cost title and the FX rates and freight total from its text line", async () => {
    const d = (await load()).dataset!;
    expect(d.tables.landedCost.map((l) => l.shipmentRef)).toEqual([O.shipment, O.shipment]);
    expect(d.tables.landedCost.map((l) => [l.planningFx, l.customsFx, l.freightTotalZar])).toEqual([[O.planningFx, O.customsFx, O.freightTotal], [O.planningFx, O.customsFx, O.freightTotal]]);
  });
  it("records where each derived value came from", async () => {
    const L = lay(await load());
    expect(L.BOM.derived).toEqual(expect.arrayContaining([{ field: "styleCode", source: "title row" }, { field: "componentName", source: "copied from Component" }]));
    expect(L.Routing_SMV.derived).toEqual(expect.arrayContaining([{ field: "styleCode", source: "title row" }, { field: "costPerMinute", source: "text line" }]));
    expect(L.LandedCost.derived).toEqual(expect.arrayContaining([{ field: "shipmentRef", source: "title row" }, { field: "freightTotalZar", source: "text line" }, { field: "fobUsd", source: "unit price x quantity" }]));
  });
  it("a report title that does not carry the identifier is an error that names OUR field, never a guessed value", async () => {
    const r = await load((wb) => void (wb.getWorksheet("BOM")!.getCell("A2").value = "A title without the identifier"));
    expect(codes(r, "context_missing").map((f) => `${f.tab}:${f.field}`)).toEqual(["BOM:styleCode"]);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.findings)).not.toContain("title without");
  });
  it("a landed-cost text line without the FX rates leaves them blank rather than inventing them", async () => {
    const r = await load((wb) => void (wb.getWorksheet("LandedCost")!.getCell("A2").value = "No rates stated here."));
    expect(r.ok).toBe(true);
    expect(r.dataset!.tables.landedCost.map((l) => l.planningFx)).toEqual([null, null]);
    expect(codes(r, "context_missing").map((f) => f.field).sort()).toEqual(["customsFx", "freightTotalZar", "planningFx"]);
    expect(codes(r, "context_missing").every((f) => f.severity === "warning")).toBe(true);
  });
});

describe("cell normalisation", () => {
  it("expands BOM size lists to one row per size, and reads 'All ...' as every size", async () => {
    const bom = (await load()).dataset!.tables.bom;
    const sizesOf = (name: string) => bom.filter((b) => b.componentName === name).map((b) => b.size);
    expect(sizesOf("Zip 32cm")).toEqual(["S", "M", "L"]);
    expect(sizesOf("Zip 34cm")).toEqual(["XL", "2XL"]);
    expect(sizesOf("Thread")).toEqual([null]);
    expect(sizesOf("Logo print")).toEqual([null]);
    expect(sizesOf("Main fabric")).toEqual([null]);
    expect(bom).toHaveLength(10);
  });
  it("reads numbers stored as text, takes the component label as code and name, and the Type column as type", async () => {
    const bom = (await load()).dataset!.tables.bom;
    const fabric = bom.find((b) => b.componentName === "Main fabric")!;
    expect(fabric).toMatchObject({ componentCode: "Main fabric", componentType: "Fabric", qtyPerUnit: 1.2, unitCost: 30, unit: "m" });
  });
  it("a Labour line whose quantity and cost point at the routing is explained and excluded, not loaded as a component", async () => {
    const r = await load();
    expect(r.dataset!.tables.bom.some((b) => b.componentType === "Labour")).toBe(false);
    expect(codes(r, "layout_row_excluded")).toEqual([expect.objectContaining({ tab: "BOM", severity: "info", reason: "routing_derived_labour", count: 1, rows: [10] })]);
    expect(lay(r).BOM.excludedRows).toBe(1);
  });
  it("a non-Labour BOM line with a non-numeric quantity is still an error (nothing unexplained is discarded)", async () => {
    const r = await load((wb) => void (wb.getWorksheet("BOM")!.getCell("D5").value = "lots"));
    expect(codes(r, "invalid_cell").map((f) => `${f.tab}:${f.field}:${f.reason}`)).toEqual(["BOM:qtyPerUnit:number_format"]);
    expect(r.ok).toBe(false);
  });
  it("an unrecognised size in an 'Applies to sizes' list is an error naming the rows, not silently dropped", async () => {
    const r = await load((wb) => void (wb.getWorksheet("BOM")!.getCell("C6").value = "S, M, XXXL"));
    expect(codes(r, "size_token_unrecognised")).toEqual([expect.objectContaining({ tab: "BOM", severity: "error", count: 1, rows: [6] })]);
  });
  it("resolves composite product text against Items: a SKU wins over its style, a style code alone gives a style-level line", async () => {
    const d = (await load()).dataset!;
    const po = d.tables.importPos;
    expect(po.map((p) => [p.poNo, p.sku, p.styleCode])).toEqual([
      ["PO-SYN-1", null, O.styleA],
      ["PO-SYN-1", `${O.styleB}-M`, null],
      ["PO-SYN-2", null, O.styleB],
      ["PO-SYN-3", null, "SYN-UNKNOWN-X (not in master)"],
    ]);
    expect(d.tables.productionOrders.map((p) => p.styleCode)).toEqual([O.styleA, O.styleA]);
  });
  it("keeps an unmatched PO line (600 units of reality) as a WARNING with the line loaded, never dropped", async () => {
    const r = await load();
    expect(r.ok).toBe(true);
    expect(codes(r, "composite_unresolved")).toEqual([expect.objectContaining({ tab: "ImportPOs", severity: "warning", count: 1, rows: [5] })]);
    expect(codes(r, "orphan_style").map((f) => `${f.tab}:${f.severity}`)).toEqual(["ImportPOs:warning"]);
    expect(codes(r, "composite_resolved")[0]).toMatchObject({ severity: "info" });
  });
  it("an unmatched ProductionOrders style is still an ERROR (only PO lines may reference products not yet in Items)", async () => {
    const r = await load((wb) => void (wb.getWorksheet("ProductionOrders")!.getCell("B4").value = "SYN-NOPE (long run)"));
    expect(r.ok).toBe(false);
    expect(codes(r, "orphan_style").filter((f) => f.severity === "error").map((f) => f.tab)).toEqual(["ProductionOrders"]);
  });
  it("an ambiguous composite (two different styles named) is not resolved", async () => {
    const r = await load((wb) => void (wb.getWorksheet("ImportPOs")!.getCell("F2").value = `${O.styleA} and ${O.styleB}`));
    expect(r.dataset!.tables.importPos[0].styleCode).toBe(`${O.styleA} and ${O.styleB}`);
    expect(codes(r, "composite_unresolved")[0].rows).toEqual([2, 5]);
  });
  it("reads a per-unit FOB header as unit price x quantity (a line total) and reports that it did", async () => {
    const d = (await load()).dataset!;
    expect(d.tables.landedCost.map((l) => l.fobUsd)).toEqual([1000, 1000]);
  });
  it("a FOB header that is already a line total is left alone", async () => {
    const r = await load((wb) => void (wb.getWorksheet("LandedCost")!.getCell("C4").value = "FOB (USD)"));
    expect(r.dataset!.tables.landedCost.map((l) => l.fobUsd)).toEqual([10, 20]);
  });
  it("accepts a style-level landed-cost line (the product is an Items style code), and still rejects a product that is neither a SKU nor a style", async () => {
    expect((await load()).ok).toBe(true);
    const r = await load((wb) => void (wb.getWorksheet("LandedCost")!.getCell("A5").value = "SYN-NOPE"));
    expect(codes(r, "orphan_sku").map((f) => f.tab)).toEqual(["LandedCost"]);
    expect(r.ok).toBe(false);
  });
  it("reads Yes/No text with a trailing description as a boolean, and rejects other text", async () => {
    const po = (await load()).dataset!.tables.importPos;
    expect(po.map((p) => p.bondOnArrival)).toEqual([true, true, false, true]);
    const r = await load((wb) => void (wb.getWorksheet("ImportPOs")!.getCell("M2").value = "Maybe later"));
    expect(codes(r, "invalid_cell").map((f) => `${f.field}:${f.reason}`)).toEqual(["bondOnArrival:boolean_format"]);
  });
  it("does not widen boolean text for other fields: 'No (x)' in an Items tender column stays invalid", async () => {
    const r = await load((wb) => {
      const ws = wb.getWorksheet("Items")!;
      ws.getCell("N1").value = "Tender";
      ws.getCell("N2").value = "No (duty-free)";
    });
    expect(codes(r, "invalid_cell").map((f) => `${f.tab}:${f.field}`)).toEqual(["Items:isTender"]);
  });
  it("reads percent-FORMATTED cells in percent points (0.8 shown as 80.0% becomes 80) and says so", async () => {
    const r = await load();
    expect(r.dataset!.tables.productionOrders.map((p) => p.labourRecoveryPct)).toEqual([80, expect.closeTo(66.6667, 3)]);
    expect(codes(r, "percent_cells_read_as_points").map((f) => `${f.tab}:${f.count}`).sort()).toEqual(["LandedCost:4", "ProductionOrders:2"]);
  });
  it("leaves a plain 0.8 (General format) alone: it never guesses that a bare fraction is a percentage", async () => {
    const r = await load((wb) => void (wb.getWorksheet("ProductionOrders")!.getCell("K4").numFmt = "General"));
    expect(r.dataset!.tables.productionOrders[0].labourRecoveryPct).toBe(0.8);
  });
  it("reads Date cells for due dates and shipment dates", async () => {
    const pay = (await load()).dataset!.tables.paymentsFec;
    expect(pay.map((p) => p.dueDate)).toEqual(["2026-11-15", "2026-11-30", "2026-09-30"]);
    expect(pay.map((p) => p.shipmentDate)).toEqual(["2026-10-16", "2026-10-31", "2026-08-31"]);
  });
});

describe("every sheet row is accounted for", () => {
  it("title + header + data + notes + explained exclusions + trailing summary/note rows = non-empty sheet rows, per tab", async () => {
    const L = lay(await load());
    for (const tab of TAB_NAMES) {
      const a = L[tab];
      expect(a.titleRows + 1 + a.dataRows + a.noteRows + a.excludedRows + a.trailingSummaryRows + a.trailingNoteRows, tab).toBe(a.sheetRows);
      expect(a.parsedRows, tab).toBe(a.dataRows + a.expandedRows);
    }
  });
  it("accounts for the specific rows", async () => {
    const L = lay(await load());
    expect(L.Items).toMatchObject({ dataRows: 10, noteRows: 1, trailingSummaryRows: 0 });
    expect(L.BOM).toMatchObject({ titleRows: 2, dataRows: 8 - 1, excludedRows: 1, expandedRows: 3, trailingSummaryRows: 3, trailingNoteRows: 2 });
    expect(L.Routing_SMV).toMatchObject({ titleRows: 2, dataRows: 3, trailingSummaryRows: 5, trailingNoteRows: 1 });
    expect(L.ProductionOrders).toMatchObject({ titleRows: 1, dataRows: 2, trailingNoteRows: 1 });
    expect(L.LandedCost).toMatchObject({ titleRows: 2, dataRows: 2 });
    expect(L.Payments_FEC).toMatchObject({ titleRows: 1, dataRows: 3 });
  });
  it("lists the note and trailing rows as value-free info findings with row numbers", async () => {
    const r = await load();
    expect(codes(r, "note_row_ignored")).toEqual([expect.objectContaining({ tab: "Items", severity: "info", count: 1, rows: [O.itemsNoteRow] })]);
    const trailing = codes(r, "layout_trailing_rows").map((f) => `${f.tab}:${f.reason}:${f.count}`).sort();
    expect(trailing).toEqual(["BOM:note:2", "BOM:summary:3", "ProductionOrders:note:1", "Routing_SMV:note:1", "Routing_SMV:summary:5"]);
  });
  it("a data-looking row after a blank gap in a report tab is reported as trailing, not parsed and not hidden", async () => {
    const r = await load((wb) => {
      const ws = wb.getWorksheet("Routing_SMV")!;
      ws.getRow(20).values = [40, "Extra op", "x", 5];
    });
    expect(lay(r).Routing_SMV.trailingSummaryRows).toBe(6);
    expect(r.dataset!.tables.routing).toHaveLength(3);
  });
  it("a non-note row with a blank key in a tabular tab is still an error", async () => {
    const r = await load((wb) => {
      const ws = wb.getWorksheet("Stock")!;
      ws.getRow(12).values = [null, null, null, null, 1, 2, 3, 4, 5, 6, 7];
    });
    expect(codes(r, "required_blank").map((f) => f.tab)).toContain("Stock");
    expect(r.ok).toBe(false);
  });
});

describe("the engines produce the hand-checked figures from the directly-loaded workbook (no engine change)", () => {
  it("landed cost: FOB x customs FX + duty + freight by CBM share, shipment-scoped", async () => {
    const d = (await load()).dataset!;
    const l = runLandedCost(d);
    expect(l.lines.map((x) => x.status)).toEqual(["complete", "complete"]);
    expect(l.lines.map((x) => (x.customsValueCents ?? 0) / 100)).toEqual([18500, 18500]);
    expect(l.lines.map((x) => (x.dutyCents ?? 0) / 100)).toEqual([2775, 3700]);
    expect(l.lines.map((x) => (x.freightCents ?? 0) / 100)).toEqual([2520, 1680]);
    expect(l.lines.map((x) => (x.landedPerUnitActualCents ?? 0) / 100)).toEqual([237.95, 477.6]);
  });
  it("production variance: recovery 80% and 66.7%, usage and price variances match the workbook's own columns", async () => {
    const v = runProductionVariance((await load()).dataset!);
    expect(v.orders.map((o) => o.labourRecoveryPct)).toEqual([80, expect.closeTo(66.6667, 3)]);
    expect(v.orders.map((o) => o.workbookDiff.recoveryPct ?? 0).every((x) => Math.abs(x) < 0.001)).toBe(true);
    expect(v.orders.map((o) => (o.priceVarianceCents ?? 0) / 100)).toEqual([126, 25.2]);
    expect(v.orders.map((o) => o.line)).toEqual(["Line 1", "Line 2"]);
  });
  it("BOM costing: component cost per size, with the longer zip from XL, and labour from the routing", async () => {
    const c = runCosting((await load()).dataset!, { percentScale: null });
    const style = c.styles.find((s) => s.styleCode === O.styleA)!;
    const nonLabour = (size: string) => style.sizes.find((z) => z.size === size)!.lines.filter((l) => !["labour", "efficiency", "overhead"].includes(l.category)).reduce((a, l) => a + l.cents, 0) / 100;
    expect([nonLabour("S"), nonLabour("L"), nonLabour("XL"), nonLabour("2XL")]).toEqual([O.nonLabourSML, O.nonLabourSML, O.nonLabourXLUp, O.nonLabourXLUp]);
    expect((style.sizes.find((z) => z.size === "M")!.labourBaseCents ?? 0) / 100).toBe(O.labour);
  });
  it("withholds the cost total while overhead and efficiency are absent from the routing (nothing assumed)", async () => {
    const c = runCosting((await load()).dataset!, { percentScale: null });
    const m = c.styles.find((s) => s.styleCode === O.styleA)!.sizes.find((z) => z.size === "M")!;
    expect(m.status).toBe("incomplete");
    expect(m.totalCents).toBeNull();
    expect(m.missing.join(" ")).toMatch(/efficiency|overhead/);
  });
  it("Red Flag and quotes run on the loaded data", async () => {
    const d = (await load()).dataset!;
    const rf = runRedFlag(d);
    expect(rf.skus).toHaveLength(10);
    expect(rf.inbound.unmatchedUnits).toBe(40);
    const q = runQuoteConversion(d);
    expect(q.total).toMatchObject({ quotes: 4, won: 2, lost: 1, open: 1, countConversionPct: expect.closeTo(66.667, 2) });
    expect(q.completeness.complete).toBe(true);
  });
});

describe("regression: the tabular synthetic workbook and the strict contract are unchanged", () => {
  it("a header row that is not the first row is NOT searched for on a tabular tab (explicit candidates only)", async () => {
    const r = await load((wb) => {
      const ws = wb.getWorksheet("Stock")!;
      ws.spliceRows(1, 0, ["A title row above the header"]);
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "missing_header").some((f) => f.tab === "Stock")).toBe(true);
  });
});
