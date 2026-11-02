import { describe, expect, it } from "vitest";
import { TAB_NAMES } from "@/rwtsa-demo/contracts/tabs";
import { readWorkbookFile } from "@/rwtsa-demo/workbook/read";
import ExcelJS from "exceljs";
import { runCosting } from "@/rwtsa-demo/engine/bom-costing";
import { runFxExposure } from "@/rwtsa-demo/engine/fx-exposure";
import { buildDataset } from "@/rwtsa-demo/workbook/build-dataset";

/**
 * LOCAL ONLY. Runs when RWTSA_WORKBOOK_PATH names the advisor's protected workbook (outside every git working tree);
 * otherwise it is skipped, which is what CI does. It asserts only structure and counts, and prints nothing: no cell value,
 * header, file name or path can reach the test output.
 */
const FILE = process.env.RWTSA_WORKBOOK_PATH;

describe.skipIf(!FILE)("the original RWTSA workbook loads directly (local only)", () => {
  it("builds a dataset from the unmodified file: no error findings, every data tab populated, every row accounted for", async () => {
    const read = await readWorkbookFile(FILE as string);
    const built = buildDataset(read, { provenance: "local-workbook", source: { label: "local-test" } });
    expect(built.findings.filter((f) => f.severity === "error").map((f) => `${f.tab}:${f.code}`)).toEqual([]);
    expect(built.ok).toBe(true);
    for (const tab of TAB_NAMES) expect(built.parsedRowCounts[tab] ?? 0, tab).toBeGreaterThan(0);
    expect(built.findings.some((f) => f.code === "supplementary_sheet")).toBe(true);
    expect(built.findings.some((f) => f.code === "unknown_tab")).toBe(false);
    for (const tab of TAB_NAMES) {
      const a = built.layout[tab]!;
      expect(a.titleRows + 1 + a.dataRows + a.noteRows + a.excludedRows + a.trailingSummaryRows + a.trailingNoteRows, tab).toBe(a.sheetRows);
      expect(a.parsedRows, tab).toBe(a.dataRows + a.expandedRows);
    }
  });

  it("routing build-up: independent read of the raw Routing_SMV sheet agrees with the loaded lines; the base BOM cost matches the reference; the analysis never changes it", async () => {
    const read = await readWorkbookFile(FILE as string);
    const built = buildDataset(read, { provenance: "local-workbook", source: { label: "local-test" } });
    const rc = built.dataset!.routingCosts!;
    expect(rc.lines.map((l) => l.kind).sort()).toEqual(["efficiency", "labour", "margin", "overhead"]);
    expect(built.findings.filter((f) => f.code === "routing_cost_mismatch")).toEqual([]);
    // Independent: walk the raw sheet below the heading, take label (col B) and amount (col D) without the adapter.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(FILE as string);
    const ws = wb.getWorksheet("Routing_SMV")!;
    const val = (r: number, c: number) => {
      const v = ws.getRow(r).getCell(c).value;
      return v !== null && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v;
    };
    let heading = 0;
    for (let r = 1; r <= ws.rowCount; r++) if (/^cost build-?up/i.test(String(val(r, 2) ?? ""))) heading = r;
    expect(heading).toBeGreaterThan(0);
    const raw: Record<string, number> = {};
    for (let r = heading + 1; r <= ws.rowCount; r++) {
      const label = String(val(r, 2) ?? "");
      const amount = Number(val(r, 4));
      if (!label || !Number.isFinite(amount)) continue;
      const kind = /overhead/i.test(label) ? "overhead" : /efficiency/i.test(label) ? "efficiency" : /margin/i.test(label) ? "margin" : /labour/i.test(label) ? "labour" : "other";
      raw[kind] = amount;
    }
    for (const l of rc.lines) expect(l.amount, l.kind).toBe(raw[l.kind]);
    // The base BOM cost of the style that carries the build-up reconciles to its reference cost, and the analysis never alters it.
    const base = runCosting(built.dataset!, { percentScale: null });
    const style = base.styles.find((st) => st.styleCode === rc.lines[0].styleCode)!;
    expect(style.sizes.find((z) => z.size === "M")!.diffCents).toBe(0);
    for (const z of style.sizes) {
      expect(z.status, z.size).toBe("complete");
      expect(z.totalCents, z.size).toBe(z.baseBomCents);
      // Items carries one flat reference cost; the size-specific component (longer zip from XL) is the only known difference.
      expect(z.diffCents as number, z.size).toBeGreaterThanOrEqual(0);
      expect(z.buildUp!.labourReconciles).toBe(true);
    }
    const alt = runCosting(built.dataset!, { percentScale: null, buildUpUnits: "per-smv-minute" });
    const zs = alt.styles.find((st) => st.styleCode === rc.lines[0].styleCode)!.sizes;
    expect(zs.map((z) => z.totalCents)).toEqual(style.sizes.map((z) => z.totalCents));
    expect(zs.every((z) => z.buildUp!.marginCents !== null && z.buildUp!.conditionalFullyLoadedCents !== (z.baseBomCents as number) + (z.buildUp!.marginCents as number))).toBe(true);
  });

  it("settlement: independent recomputation from the raw Payments_FEC sheet agrees with the engine, and nothing past due is treated as settled", async () => {
    const read = await readWorkbookFile(FILE as string);
    const built = buildDataset(read, { provenance: "local-workbook", source: { label: "local-test" } });
    const r = runFxExposure(built.dataset!, { asOf: "2026-10-31" });
    // Independent: read the sheet directly (header on row 3), without the adapter.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(FILE as string);
    const ws = wb.getWorksheet("Payments_FEC")!;
    const head = (ws.getRow(3).values as unknown[]).slice(1).map((v) => String(v ?? ""));
    const col = (re: RegExp) => head.findIndex((h) => re.test(h)) + 1;
    const cUsd = col(/^USD amount/i), cTerms = col(/^Terms/i), cRemark = col(/^Remark/i), cShip = col(/^Shipment date/i), cDue = col(/^Due date/i);
    const day = (v: unknown) => {
      const x = v !== null && typeof v === "object" && "result" in (v as object) ? (v as { result: unknown }).result : v; // formula cells keep their value in `result`
      return x instanceof Date ? x.toISOString().slice(0, 10) : String(x ?? "");
    };
    let scheduled = 0, deposit = 0;
    for (let i = 4; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const usd = Number(row.getCell(cUsd).value);
      if (!Number.isFinite(usd)) continue;
      scheduled += Math.round(usd * 100);
      const remark = String(row.getCell(cRemark).value ?? "");
      if (Number(row.getCell(cTerms).value) === 0 && /^\s*deposit\b/i.test(remark) && day(row.getCell(cShip).value) === day(row.getCell(cDue).value)) deposit += Math.round(usd * 100);
    }
    expect(r.totals.scheduledUsdCents).toBe(scheduled);
    expect(r.totals.paidUsdCents).toBe(deposit);
    expect(r.totals.potentialUsdCents).toBe(scheduled - deposit);
    expect(r.totals.potentialUsdCents).toBeGreaterThan(0); // the defect: it used to be zero here
    expect(r.totals.confirmedOpenUsdCents).toBeNull();
    // moving the as-at date never changes the exposure
    expect(runFxExposure(built.dataset!, { asOf: "2027-06-30" }).totals.potentialUsdCents).toBe(r.totals.potentialUsdCents);
  });
});
