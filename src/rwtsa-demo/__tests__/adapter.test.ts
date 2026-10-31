import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { buildFrom, buildSynth, codes, colOf, sheet, synthBuffer } from "@/rwtsa-demo/__tests__/helpers";
import { readWorkbookBuffer } from "@/rwtsa-demo/workbook/read";
import { RwtsaSafeError } from "@/rwtsa-demo/findings";

describe("workbook adapter: a clean synthetic workbook", () => {
  it("round-trips through a real .xlsx and builds a complete typed dataset tagged synthetic", async () => {
    const r = await buildSynth();
    expect(r.ok).toBe(true);
    const d = r.dataset!;
    expect(d.provenance).toBe("synthetic");
    expect(d.tables.items).toHaveLength(24); // 3 styles x 8 sizes
    expect(d.tables.stock).toHaveLength(24);
    expect(d.months).toHaveLength(36);
    expect(d.months[0]).toBe("2023-09");
    expect(d.months[35]).toBe("2026-08");
    expect(d.tables.salesHistory).toHaveLength(24 * 36);
    expect(r.findings.filter((f) => f.severity === "error")).toEqual([]);
  });

  it("AT-1: header-based loading gives identical output when columns and rows are shuffled", async () => {
    const plain = await buildSynth();
    const shuffled = await buildSynth({ shuffleColumns: true, shuffleRows: true });
    expect(shuffled.ok).toBe(true);
    expect(shuffled.dataset!.reconciliation.controlHash).toBe(plain.dataset!.reconciliation.controlHash);
    expect(shuffled.dataset!.reconciliation.unitsByStyle).toEqual(plain.dataset!.reconciliation.unitsByStyle);
  });

  it("accepts header aliases (e.g. 'Item code' for SKU) because matching is by normalised name", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Items");
      ws.getRow(1).getCell(colOf(ws, "SKU")).value = "Item_Code";
    });
    expect(r.ok).toBe(true);
  });

  it("a local header-map override resolves a real header that differs from every alias, without a code change", async () => {
    const mutate = (wb: ExcelJS.Workbook) => {
      const ws = sheet(wb, "Stock");
      ws.getRow(1).getCell(colOf(ws, "Committed")).value = "Allocated qty";
    };
    const without = await buildSynth({}, mutate);
    expect(without.ok).toBe(false);
    expect(codes(without, "missing_header").map((f) => f.field)).toEqual(["committed"]);
    const withMap = await buildSynth({}, mutate, { Stock: { committed: "Allocated qty" } });
    expect(withMap.ok).toBe(true);
  });
});

describe("AT-2: missing-column reporting", () => {
  it("reports EVERY missing required header at once, per tab, by our canonical field key, and returns no dataset", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Stock");
      ws.spliceColumns(colOf(ws, "Cape Town"), 1);
      const ws2 = sheet(wb, "Stock");
      ws2.spliceColumns(colOf(ws2, "Bond"), 1);
      const items = sheet(wb, "Items");
      items.spliceColumns(colOf(items, "Standard cost"), 1);
    });
    expect(r.ok).toBe(false);
    expect(r.dataset).toBeNull();
    const missing = codes(r, "missing_header").map((f) => `${f.tab}:${f.field}`).sort();
    expect(missing).toEqual(["Items:standardCost", "Stock:bond", "Stock:capeTown"]);
  });

  it("AT-5: a missing tab is an error and an unknown extra tab is only a warning", async () => {
    const missing = await buildSynth({}, (wb) => {
      wb.removeWorksheet(sheet(wb, "Customers").id);
    });
    expect(missing.ok).toBe(false);
    expect(codes(missing, "missing_tab").map((f) => f.tab)).toEqual(["Customers"]);

    const extra = await buildSynth({}, (wb) => {
      wb.addWorksheet("Some Other Tab").addRow(["x"]);
    });
    expect(extra.ok).toBe(true);
    const unknown = codes(extra, "unknown_tab");
    expect(unknown).toHaveLength(1);
    expect(unknown[0].severity).toBe("warning");
    expect(unknown[0].count).toBe(1);
  });

  it("matches sheet names by normalised name (e.g. 'Routing SMV' for Routing_SMV)", async () => {
    const r = await buildSynth({}, (wb) => {
      sheet(wb, "Routing_SMV").name = "Routing SMV";
    });
    expect(r.ok).toBe(true);
  });
});

describe("AT-4: formula cells", () => {
  it("uses a formula cell's CACHED result", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Stock");
      ws.getRow(2).getCell(colOf(ws, "JHB")).value = { formula: "10+5", result: 15 };
    });
    expect(r.ok).toBe(true);
    expect(r.dataset!.tables.stock[0].jhb).toBe(15);
  });

  it("treats a formula with no cached result as blank (never recomputed or guessed) and warns", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Items");
      ws.getRow(2).getCell(colOf(ws, "Description")).value = { formula: "1+1" } as ExcelJS.CellFormulaValue;
    });
    expect(r.ok).toBe(true);
    const w = codes(r, "formula_without_cached_result");
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ severity: "warning", tab: "Items", count: 1 });
    expect(r.dataset!.tables.items[0].description).toBeNull();
  });

  it("a required cell that is a formula without a result is an error, not a silent zero", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Stock");
      ws.getRow(2).getCell(colOf(ws, "JHB")).value = { formula: "1+1" } as ExcelJS.CellFormulaValue;
    });
    expect(r.ok).toBe(false);
    expect(codes(r, "required_blank").map((f) => `${f.tab}:${f.field}`)).toEqual(["Stock:jhb"]);
  });
});

describe("AT-7: month unpivoting", () => {
  it("unpivots YYYY-MM columns into (sku, month, qty) points that equal the source cells", async () => {
    const buf = await synthBuffer();
    const r = await buildFrom(buf);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = sheet(wb, "SalesHistory");
    const sku = ws.getRow(2).getCell(colOf(ws, "SKU")).value as string;
    for (const month of ["2023-09", "2025-03", "2026-08"]) {
      const expected = ws.getRow(2).getCell(colOf(ws, month)).value as number;
      expect(r.dataset!.tables.salesHistory.find((p) => p.sku === sku && p.month === month)?.qty).toBe(expected);
    }
  });

  it("accepts a first-of-month date as a month header", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      ws.getRow(1).getCell(colOf(ws, "2026-08")).value = new Date(Date.UTC(2026, 7, 1));
    });
    expect(r.ok).toBe(true);
    expect(r.dataset!.months[35]).toBe("2026-08");
  });

  it("rejects an invalid month header, a duplicate month and a gap", async () => {
    const invalid = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      ws.getRow(1).getCell(colOf(ws, "2026-08")).value = "2026-8";
    });
    expect(codes(invalid, "invalid_month_header")).toHaveLength(1);
    expect(invalid.ok).toBe(false);

    const dup = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      ws.getRow(1).getCell(colOf(ws, "2026-08")).value = "2026-07";
    });
    expect(codes(dup, "duplicate_month")).toHaveLength(1);

    const gap = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "SalesHistory");
      ws.spliceColumns(colOf(ws, "2025-01"), 1);
    });
    expect(codes(gap, "month_gap")).toHaveLength(1);
    expect(gap.dataset).toBeNull();
  });
});

describe("AT-6: Available stock reconciliation", () => {
  it("computes Available = JHB + Durban + Cape Town + Factory store - Committed, excluding Bond and In transit", async () => {
    const r = await buildSynth();
    for (const s of r.dataset!.tables.stock) {
      expect(s.availableComputed).toBe(s.jhb + s.durban + s.capeTown + s.factoryStore - s.committed);
    }
    const withBondAndTransit = r.dataset!.tables.stock.filter((s) => s.bond > 0 && s.inTransit > 0);
    expect(withBondAndTransit.length).toBeGreaterThan(0);
    for (const s of withBondAndTransit) expect(s.availableComputed).not.toBe(s.availableComputed + s.bond + s.inTransit);
    expect(codes(r, "available_mismatch")).toHaveLength(0);
  });

  it("reports (as a count) rows where the file's own Available column disagrees", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Stock");
      const c = colOf(ws, "Available");
      for (const row of [2, 3]) {
        const cell = ws.getRow(row).getCell(c);
        cell.value = (cell.value as number) + 1;
      }
    });
    expect(r.ok).toBe(true); // a warning, not an error: the data is usable and the owner decides
    const m = codes(r, "available_mismatch");
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ severity: "warning", count: 2, rows: [2, 3] });
  });
});

describe("AT-8: duplicate, orphan and rule findings (value-free)", () => {
  it("detects a duplicate natural key and drops the later row", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Items");
      ws.addRow(ws.getRow(2).values as ExcelJS.CellValue[]);
    });
    expect(r.ok).toBe(false);
    const d = codes(r, "duplicate_key");
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ tab: "Items", field: "sku", count: 1 });
  });

  it("detects orphan SKUs and orphan styles across tabs", async () => {
    const r = await buildSynth({}, (wb) => {
      const stock = sheet(wb, "Stock");
      stock.getRow(2).getCell(colOf(stock, "SKU")).value = "NOT-IN-ITEMS";
      const pos = sheet(wb, "ImportPOs");
      pos.getRow(2).getCell(colOf(pos, "Style code")).value = "NOT-A-STYLE";
    });
    expect(codes(r, "orphan_sku").map((f) => f.tab)).toEqual(["Stock"]);
    expect(codes(r, "orphan_style").map((f) => f.tab)).toEqual(["ImportPOs"]);
    expect(r.ok).toBe(false);
  });

  it("warns when a tender SKU carries a standing min level (DP-16)", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Items");
      // the tender SKU is the last row (last style, 5XL)
      ws.getRow(ws.rowCount).getCell(colOf(ws, "Min level")).value = 10;
    });
    expect(r.ok).toBe(true);
    expect(codes(r, "tender_with_min_level")).toHaveLength(1);
  });

  it("warns when a lost quote has no reason (CRM-06)", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "Quotes");
      const status = colOf(ws, "Status");
      const reason = colOf(ws, "Lost reason");
      for (let row = 2; row <= ws.rowCount; row++) {
        if (ws.getRow(row).getCell(status).value === "lost") {
          ws.getRow(row).getCell(reason).value = null;
          break;
        }
      }
    });
    expect(codes(r, "lost_without_reason")).toHaveLength(1);
  });

  it("reports invalid cells by reason class with counts and row numbers, never values", async () => {
    const r = await buildSynth({}, (wb) => {
      const stock = sheet(wb, "Stock");
      stock.getRow(2).getCell(colOf(stock, "JHB")).value = "1,5";
      stock.getRow(3).getCell(colOf(stock, "JHB")).value = "abc";
      const pos = sheet(wb, "ImportPOs");
      pos.getRow(2).getCell(colOf(pos, "ETA stores")).value = "next week";
      const q = sheet(wb, "Quotes");
      q.getRow(2).getCell(colOf(q, "Status")).value = "pending";
    });
    const inv = codes(r, "invalid_cell").map((f) => `${f.tab}:${f.field}:${f.reason}:${f.count}`).sort();
    expect(inv).toEqual(["ImportPOs:etaStores:date_format:1", "Quotes:status:enum_value:1", "Stock:jhb:number_format:2"]);
    expect(r.ok).toBe(false);
  });

  it("rejects a PO row that has neither a SKU nor a style", async () => {
    const r = await buildSynth({}, (wb) => {
      const ws = sheet(wb, "ImportPOs");
      ws.getRow(2).getCell(colOf(ws, "Style code")).value = null;
    });
    expect(codes(r, "po_missing_sku_and_style")).toHaveLength(1);
  });
});

describe("resource limits and bad input", () => {
  it("rejects a sheet whose header row exceeds the column cap", async () => {
    const buf = await synthBuffer({}, (wb) => {
      const ws = sheet(wb, "Quotes");
      ws.getRow(1).getCell(250).value = "extra";
    });
    const read = await readWorkbookBuffer(buf);
    expect(read.findings.some((f) => f.code === "too_many_columns" && f.tab === "Quotes")).toBe(true);
  });

  it("rejects a file that is not an .xlsx workbook with a value-free error", async () => {
    await expect(readWorkbookBuffer(Buffer.from("this is not a workbook"))).rejects.toBeInstanceOf(RwtsaSafeError);
  });
});
