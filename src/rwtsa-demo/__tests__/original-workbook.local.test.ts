import { describe, expect, it } from "vitest";
import { TAB_NAMES } from "@/rwtsa-demo/contracts/tabs";
import { readWorkbookFile } from "@/rwtsa-demo/workbook/read";
import ExcelJS from "exceljs";
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
    const cUsd = col(/^USD amount/i), cTerms = col(/^Terms/i), cRemark = col(/^Remark/i);
    let scheduled = 0, deposit = 0;
    for (let i = 4; i <= ws.rowCount; i++) {
      const row = ws.getRow(i);
      const usd = Number(row.getCell(cUsd).value);
      if (!Number.isFinite(usd)) continue;
      scheduled += Math.round(usd * 100);
      const remark = String(row.getCell(cRemark).value ?? "");
      if (Number(row.getCell(cTerms).value) === 0 && /\bdeposit\b/i.test(remark)) deposit += Math.round(usd * 100);
    }
    expect(r.totals.scheduledUsdCents).toBe(scheduled);
    expect(r.totals.paidUsdCents).toBe(deposit);
    expect(r.totals.potentialUsdCents).toBe(scheduled - deposit);
    expect(r.totals.potentialUsdCents).toBeGreaterThan(0); // the defect: it used to be zero here
    expect(r.totals.confirmedOpenUsdCents).toBeNull();
    // moving the as-at date never changes the exposure
    expect(runFxExposure(built.dataset!, { asOf: "2026-01-01" }).totals.potentialUsdCents).toBe(r.totals.potentialUsdCents);
  });
});
