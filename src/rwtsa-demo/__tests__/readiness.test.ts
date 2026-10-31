import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildFrom, codes, colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import type { ReadinessConfig } from "@/rwtsa-demo/dataset";
import { RwtsaSafeError } from "@/rwtsa-demo/findings";
import { buildDataset } from "@/rwtsa-demo/workbook/build-dataset";
import { readWorkbookBuffer } from "@/rwtsa-demo/workbook/read";

/**
 * Scenario readiness is SEPARATE from structural validity. A workbook can be structurally valid with no scenario
 * ready, and a scenario is never ready because a header exists or because blanks were treated as zero.
 */

async function build(mutate?: (wb: ExcelJS.Workbook) => void, readiness?: Partial<ReadinessConfig>) {
  const buffer = await synthBuffer({}, mutate);
  const read = await readWorkbookBuffer(buffer);
  return buildDataset(read, { provenance: "synthetic", source: { label: "synthetic:test" }, readiness });
}
const by = (r: Awaited<ReturnType<typeof build>>) => Object.fromEntries(r.readiness.map((x) => [x.scenario, x]));
const emptyExcept = (keep: string[]) => (wb: ExcelJS.Workbook) =>
  wb.eachSheet((ws) => {
    if (keep.includes(ws.name)) return;
    for (let i = ws.rowCount; i > 1; i--) ws.spliceRows(i, 1);
  });
/** Month columns are 2..37 (oldest..newest) in an unshuffled synthetic SalesHistory. */
const setSales = (wb: ExcelJS.Workbook, row: number, cols: number[], value: number | null) => {
  for (const c of cols) sheet(wb, "SalesHistory").getRow(row).getCell(c).value = value;
};
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("PASS with zero scenarios READY is legitimate and never means demonstration-ready", () => {
  it("core tabs populated, everything else empty: structurally valid, no scenario ready", async () => {
    const r = await build(emptyExcept(["Items", "SalesHistory", "Stock"]));
    expect(r.ok).toBe(true);
    expect(r.dataset).not.toBeNull();
    expect(r.readiness.filter((x) => x.ready)).toHaveLength(0);
    expect(by(r).A.missingTabs).toEqual(["ImportPOs"]); // A fails only for the missing PO records
  });

  it("a fully populated workbook has all four scenarios READY", async () => {
    const r = await build();
    expect(r.ok).toBe(true);
    expect(r.readiness.every((x) => x.ready)).toBe(true);
    expect(by(r).A.salesWindow).toEqual({ requiredMonths: 6, availableMonths: 36, skusIncomplete: 0 });
    expect(by(r).B.salesWindow).toBeNull();
  });
});

describe("a critical column that is present but unpopulated is NOT ready", () => {
  it("Items.minLevel present but entirely blank: scenario A not ready, workbook still valid", async () => {
    const r = await build((wb) => {
      const ws = sheet(wb, "Items");
      for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Min level")).value = null;
    });
    expect(r.ok).toBe(true);
    const a = by(r).A;
    expect(a.ready).toBe(false);
    expect(a.missingFields).toEqual([]); // the header exists...
    expect(a.unpopulatedFields).toEqual([{ field: "Items.minLevel", missing: 23 }]); // ...but 23 non-tender rows have no value
    expect(by(r).B.ready && by(r).C.ready && by(r).D.ready).toBe(true);
  });

  it("a tender SKU may legitimately have no min level (DP-16)", async () => {
    const r = await build();
    expect(by(r).A.unpopulatedFields).toEqual([]);
  });

  it("an explicit 0 min level IS an observation (not treated as missing)", async () => {
    const r = await build((wb) => {
      const ws = sheet(wb, "Items");
      for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Min level")).value = 0;
    });
    expect(by(r).A.ready).toBe(true);
    expect(r.dataset!.tables.items.filter((i) => i.minLevel === 0).length).toBeGreaterThan(0);
  });

  it("Items.isTender present but blank is NOT silently false; explicit false counts as an observation", async () => {
    const blank = await build((wb) => {
      const ws = sheet(wb, "Items");
      for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Tender")).value = null;
    });
    expect(by(blank).A.ready).toBe(false);
    expect(by(blank).A.unpopulatedFields.map((u) => u.field)).toContain("Items.isTender");

    const partial = await build((wb) => {
      const ws = sheet(wb, "Items");
      ws.getRow(3).getCell(colOf(ws, "Tender")).value = null;
      ws.getRow(4).getCell(colOf(ws, "Tender")).value = null;
    });
    expect(by(partial).A.unpopulatedFields).toContainEqual({ field: "Items.isTender", missing: 2 });

    const explicitFalse = await build(); // the synthetic workbook writes explicit true/false for every row
    expect(explicitFalse.dataset!.tables.items.filter((i) => i.isTender === false).length).toBeGreaterThan(0);
    expect(by(explicitFalse).A.ready).toBe(true);
  });

  it("scenario C: an all-blank critical column is not ready, a single explicit 0 makes it populated", async () => {
    const blank = await build((wb) => {
      const ws = sheet(wb, "LandedCost");
      for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Duty")).value = null;
    });
    expect(by(blank).C.ready).toBe(false);
    expect(by(blank).C.unpopulatedFields).toEqual([{ field: "LandedCost.dutyZar", missing: 5 }]);

    const oneZero = await build((wb) => {
      const ws = sheet(wb, "LandedCost");
      for (let row = 2; row <= ws.rowCount; row++) ws.getRow(row).getCell(colOf(ws, "Duty")).value = null;
      ws.getRow(2).getCell(colOf(ws, "Duty")).value = 0;
    });
    expect(by(oneZero).C.ready).toBe(true);
  });

  it("scenario D: every LOST quote needs a reason and every WON quote an order reference", async () => {
    const r = await build((wb) => {
      const ws = sheet(wb, "Quotes");
      const status = colOf(ws, "Status");
      for (let row = 2; row <= ws.rowCount; row++) {
        if (ws.getRow(row).getCell(status).value === "lost") ws.getRow(row).getCell(colOf(ws, "Lost reason")).value = null;
        if (ws.getRow(row).getCell(status).value === "won") ws.getRow(row).getCell(colOf(ws, "Converted order")).value = null;
      }
    });
    expect(r.ok).toBe(true);
    expect(by(r).D.ready).toBe(false);
    expect(by(r).D.unpopulatedFields.map((u) => u.field).sort()).toEqual(["Quotes.convertedOrder", "Quotes.lostReason"]);
  });

  it("no scenario is ready when the workbook is invalid, however populated", async () => {
    const r = await build((wb) => {
      sheet(wb, "Stock").getRow(2).getCell(2).value = "SYN-VEST-B"; // style mismatch => error
    });
    expect(r.ok).toBe(false);
    expect(r.readiness.every((x) => !x.ready)).toBe(true);
  });
});

describe("scenario A: a complete recent sales window for every SKU", () => {
  it("a blank month INSIDE the 6-month window makes A NOT READY, not the workbook invalid", async () => {
    const r = await build((wb) => setSales(wb, 2, [34], null));
    expect(r.ok).toBe(true);
    expect(by(r).A.ready).toBe(false);
    expect(by(r).A.salesWindow).toEqual({ requiredMonths: 6, availableMonths: 36, skusIncomplete: 1 });
    expect(codes(r, "missing_observation")).toHaveLength(1); // still reported, value-free
    expect(by(r).B.ready && by(r).C.ready && by(r).D.ready).toBe(true);
  });

  it("a blank month OUTSIDE the window does not affect readiness", async () => {
    const r = await build((wb) => setSales(wb, 2, [5, 6], null));
    expect(r.ok).toBe(true);
    expect(by(r).A.ready).toBe(true);
  });

  it("explicit zeros across the whole window ARE valid observations; the same cells blank are not", async () => {
    const zeros = await build((wb) => {
      for (let row = 2; row <= 25; row++) setSales(wb, row, range(32, 37), 0);
    });
    expect(by(zeros).A.ready).toBe(true);
    expect(zeros.dataset!.reconciliation.totals.salesMissingObservations).toBe(0);

    const blanks = await build((wb) => {
      for (let row = 2; row <= 25; row++) setSales(wb, row, range(32, 37), null);
    });
    expect(blanks.ok).toBe(true);
    expect(by(blanks).A.ready).toBe(false);
    expect(by(blanks).A.salesWindow!.skusIncomplete).toBe(24);
  });

  it("mostly blank history (only the first 3 months populated): structurally valid, A not ready, others unaffected", async () => {
    const r = await build((wb) => {
      for (let row = 2; row <= 25; row++) setSales(wb, row, range(5, 37), null);
    });
    expect(r.ok).toBe(true);
    expect(by(r).A.ready).toBe(false);
    expect(by(r).A.salesWindow).toEqual({ requiredMonths: 6, availableMonths: 36, skusIncomplete: 24 });
    expect(r.readiness.filter((x) => x.ready).map((x) => x.scenario)).toEqual(["B", "C", "D"]);
  });

  it("fewer month columns than the window: A not ready, workbook valid", async () => {
    const r = await build((wb) => {
      const ws = sheet(wb, "SalesHistory");
      ws.spliceColumns(2, 32); // keep only the 4 most recent months
    });
    expect(r.ok).toBe(true);
    expect(by(r).A.salesWindow).toMatchObject({ requiredMonths: 6, availableMonths: 4 });
    expect(by(r).A.ready).toBe(false);
  });

  it("the window is configurable: a gap 8 months back is fine for 6 months, fatal for 12", async () => {
    const gap = (wb: ExcelJS.Workbook) => setSales(wb, 2, [30], null); // 8th most recent month
    expect(by(await build(gap, { forecastWindowMonths: 6 })).A.ready).toBe(true);
    const twelve = await build(gap, { forecastWindowMonths: 12 });
    expect(by(twelve).A.ready).toBe(false);
    expect(by(twelve).A.salesWindow).toMatchObject({ requiredMonths: 12, skusIncomplete: 1 });
    expect(by(await build(undefined, { forecastWindowMonths: 36 })).A.ready).toBe(true);
  });

  it("rejects a nonsensical window with a value-free error", async () => {
    for (const bad of [0, 1.5, 37, Number.NaN]) {
      await expect(build(undefined, { forecastWindowMonths: bad })).rejects.toBeInstanceOf(RwtsaSafeError);
    }
  });

  it("an invalid (non-numeric) month cell is still a structural error, never a silent gap", async () => {
    const r = await build((wb) => {
      sheet(wb, "SalesHistory").getRow(2).getCell(34).value = "n/a";
    });
    expect(r.ok).toBe(false);
    expect(by(r).A.ready).toBe(false);
  });
});

describe("buildFrom still works with default readiness (helper regression)", () => {
  it("default config is the brief's 6-month window", async () => {
    const r = await buildFrom(await synthBuffer());
    expect(r.readinessConfig).toEqual({ forecastWindowMonths: 6 });
  });
});
