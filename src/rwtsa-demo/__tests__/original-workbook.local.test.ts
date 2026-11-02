import { describe, expect, it } from "vitest";
import { TAB_NAMES } from "@/rwtsa-demo/contracts/tabs";
import { readWorkbookFile } from "@/rwtsa-demo/workbook/read";
import ExcelJS from "exceljs";
import { runCosting } from "@/rwtsa-demo/engine/bom-costing";
import { runFxExposure } from "@/rwtsa-demo/engine/fx-exposure";
import { runRedFlag } from "@/rwtsa-demo/engine";
import { REV2_SIZE_CURVE } from "@/rwtsa-demo/engine/size-curve";
import { buildDataset } from "@/rwtsa-demo/workbook/build-dataset";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildExport, type ExchangeSource } from "@/rwtsa-demo/fastreact/export";
import { buildSampleReturn, parseReturnFile } from "@/rwtsa-demo/fastreact/return-format";
import { EMPTY_RETURNS, planReturn } from "@/rwtsa-demo/fastreact/return-reconcile";

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

  it("Scenario A core: six- and twelve-month averages reconcile to the workbook's own references; stale history is reported; the Rev2 curve allocates exactly", async () => {
    const read = await readWorkbookFile(FILE as string);
    const built = buildDataset(read, { provenance: "local-workbook", source: { label: "local-test" } });
    const d = built.dataset!;
    const r = runRedFlag(d, { historyAnchor: "last-available", overdueOnWater: "exclude", sizeCurve: { kind: "explicit", weights: REV2_SIZE_CURVE } });
    // history: every SKU's six- and twelve-month average agrees with the workbook's own reference columns
    expect(r.comparison.compared6).toBe(d.tables.items.length);
    expect(r.comparison.matched6).toBe(r.comparison.compared6);
    expect(r.comparison.compared12).toBe(d.tables.items.length);
    expect(r.comparison.matched12).toBe(r.comparison.compared12);
    // independent recomputation of the six-month average from the raw SalesHistory sheet
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(FILE as string);
    const ws = wb.getWorksheet("SalesHistory")!;
    const head = (ws.getRow(1).values as unknown[]).slice(1).map((v) => String(v ?? ""));
    const monthCols = head.map((h, i) => ({ h, c: i + 1 })).filter((x) => /^\d{4}-\d{2}$/.test(x.h));
    const last6 = monthCols.slice(-6);
    expect(last6[last6.length - 1].h).toBe(r.window.windowEnd);
    for (let i = 2; i <= Math.min(ws.rowCount, 12); i++) {
      const sku = String(ws.getRow(i).getCell(1).value);
      const avg = last6.reduce((t, x) => t + Number(ws.getRow(i).getCell(x.c).value), 0) / 6;
      expect(r.skus.find((x) => x.sku === sku)!.monthlyForecast, sku).toBeCloseTo(avg, 9);
    }
    // stale history: reported, nothing invented
    expect(r.window.staleMonths).toBeGreaterThan(0);
    expect(r.window.staleWarning).not.toBeNull();
    expect(r.window.months.every((m) => m <= (r.window.lastHistoryMonth as string))).toBe(true);
    // Rev2 curve: style-level lines split exactly, and the Items minimum levels reproduce the curve for every style with all sizes
    const sa = r.inbound.sizeAllocation;
    expect(sa.reconciles).toBe(true);
    expect(sa.unitsAllocated).toBe(sa.unitsIn);
    const byStyle = new Map<string, typeof d.tables.items>();
    for (const it of d.tables.items) byStyle.set(it.styleCode, [...(byStyle.get(it.styleCode) ?? []), it]);
    let full = 0;
    let reproduced = 0;
    for (const items of byStyle.values()) {
      if (items.length !== 8) continue;
      full += 1;
      const total = items.reduce((t, i) => t + (i.minLevel ?? 0), 0);
      if (items.every((i) => Math.abs((100 * (i.minLevel ?? 0)) / total - REV2_SIZE_CURVE[i.size]) <= 1)) reproduced += 1;
    }
    expect(full).toBeGreaterThan(0);
    expect(reproduced).toBe(full);
    // overdue: kept apart; excluded from usable inbound under the conservative treatment; nothing double counted
    const ex = runRedFlag(d, { historyAnchor: "last-available", overdueOnWater: "exclude", sizeCurve: { kind: "explicit", weights: REV2_SIZE_CURVE } });
    const wk = runRedFlag(d, { historyAnchor: "last-available", overdueOnWater: "week-1", sizeCurve: { kind: "explicit", weights: REV2_SIZE_CURVE } });
    expect(ex.inbound.overdueOnWaterUnits).toBe(wk.inbound.overdueOnWaterUnits);
    expect(ex.skus.reduce((t, s) => t + s.inboundTotal, 0)).toBeLessThanOrEqual(wk.skus.reduce((t, s) => t + s.inboundTotal, 0));
    expect(ex.skus.map((s) => s.available)).toEqual(wk.skus.map((s) => s.available));
  });
});

describe.skipIf(!FILE)("Fast React exchange on the original workbook (local only)", () => {
  const load = async () => {
    const read = await readWorkbookFile(FILE as string);
    const built = buildDataset(read, { provenance: "local-workbook", source: { label: "local-test" } });
    if (!built.ok || built.dataset === null) throw new Error("dataset not built");
    const t = built.dataset.tables;
    const source: ExchangeSource = {
      provenance: "local-workbook",
      sourceLabel: "local-test",
      customers: t.customers.map((c) => c.customer),
      items: t.items.map((i) => ({ sku: i.sku, styleCode: i.styleCode, productionCode: i.productionCode ?? null, description: i.description ?? null })),
      orders: t.productionOrders.map((o) => ({ orderNo: o.orderNo, styleCode: o.styleCode, qty: o.qty })),
    };
    return { source, t };
  };
  const sha = (f: string) => createHash("sha256").update(readFileSync(f)).digest("hex");
  const opts = { delimiter: "tab", dateFormat: "YYYY-MM-DD", headerStyle: "standard", selectedOrders: null, updates: [] } as const;

  it("without planner inputs: CUSTOMER is valid, the order-dependent files fail on exactly the values the workbook lacks, and nothing is substituted", async () => {
    const { source, t } = await load();
    const r = buildExport(source, { orders: {}, productTypes: {} }, opts);
    const by = (id: string) => r.files.find((f) => f.id === id)!;
    expect(by("CUSTOMER").status).toBe("READY");
    expect(by("CUSTOMER").rowCount).toBe(new Set(t.customers.map((c) => c.customer)).size);
    expect(by("PRODUCTS").status).toBe("FAILED");
    expect(by("PRODUCTS").issues.every((i) => i.field === "P.TYPE" && i.kind === "missing-required")).toBe(true);
    expect(by("ORDERS").status).toBe("FAILED");
    expect(new Set(by("ORDERS").issues.map((i) => `${i.field}:${i.kind}`))).toEqual(new Set(["O.PROD:reference", "O.CUST:missing-required", "O^DD:1:missing-required"]));
    expect(by("UPDATE").status).toBe("NOT_EXPORTABLE");
    expect(r.baseSetReady).toBe(false);
  });

  it("with planner-stated customer, date and product type: the base set is valid and consistent, deterministic, and matches the production orders", async () => {
    const { source, t } = await load();
    const customers = [...new Set(source.customers)].sort();
    const supp = {
      orders: Object.fromEntries(source.orders.map((o, i) => [o.orderNo, { customer: customers[i % customers.length], deliveryDate: "2026-12-04", status: null }])),
      productTypes: Object.fromEntries([...new Set(source.orders.map((o) => o.styleCode))].map((s) => [s, { code: "TYPE-A" }])),
    };
    const r = buildExport(source, supp, opts);
    expect(r.files.slice(0, 4).map((f) => f.status)).toEqual(["READY", "READY", "READY", "READY"]);
    expect(r.baseSetReady).toBe(true);
    const orders = r.files.find((f) => f.id === "ORDERS")!;
    expect(orders.rowCount).toBe(t.productionOrders.length);
    const rows = (orders.text as string).trimEnd().split("\r\n").slice(1).map((l) => l.split("\t"));
    for (const o of t.productionOrders) expect(rows.some((c) => c[0] === o.orderNo && Number(c[4]) === o.qty)).toBe(true);
    const again = buildExport(source, supp, opts);
    expect(again.files.map((f) => f.sha256)).toEqual(r.files.map((f) => f.sha256));
    // every exported product code is the style's single production code from Items
    const prod = r.files.find((f) => f.id === "PRODUCTS")!;
    const codes = new Set(t.items.map((i) => i.productionCode));
    for (const l of (prod.text as string).trimEnd().split("\r\n").slice(1)) expect(codes.has(l.split("\t")[0])).toBe(true);
  });

  it("running the export and a return-file plan never alters the workbook file", async () => {
    const before = sha(FILE as string);
    const { source } = await load();
    buildExport(source, { orders: {}, productTypes: {} }, opts);
    const text = buildSampleReturn(source.orders.map((o) => ({ orderNo: o.orderNo, qty: o.qty })), new Date());
    const plan = planReturn(parseReturnFile(text), source.orders.map((o) => ({ orderNo: o.orderNo, qty: o.qty })), EMPTY_RETURNS, { now: new Date(), fileHash: "x" });
    expect(plan.rows.every((r) => r.outcome === "NEW")).toBe(true);
    expect(sha(FILE as string)).toBe(before);
  });
});
