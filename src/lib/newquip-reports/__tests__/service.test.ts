import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The loader's costing path calls the mapping library; it must not need a database here.
vi.mock("@/lib/projects/package-mapping-store", () => ({ listActiveMappings: vi.fn(async () => null), libraryOf: vi.fn(() => new Map()) }));

import { bottleneckReport, costingReport, exportReport, overviewReport, pipelineReport, type ReportViewer } from "../service";
import { loadCostingRows } from "../load";
import { emptyDraft } from "@/newquip/grower/draft";

const ORG = "org-newquip"; const OTHER = "org-other";
type Row = Record<string, unknown>;
/** A recording fake of the service-role client: every select is logged with its filters; rows are filtered by the org_id the query asked for (so a missing org filter would leak the other org's rows). */
function fakeDb(tables: Record<string, Row[]>) {
  const calls: Array<{ table: string; cols: string; eq: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      const rec = { table, cols: "", eq: {} as Record<string, unknown> }; calls.push(rec); let inIds: string[] | null = null;
      const q: Record<string, unknown> = {
        select(c: string) { rec.cols = c; return q; }, eq(k: string, v: unknown) { rec.eq[k] = v; return q; }, in(_k: string, ids: string[]) { inIds = ids; return q; }, order() { return q; },
        range(from: number, to: number) { return Promise.resolve({ data: filtered().slice(from, to + 1), error: null }); },
        then(res: (v: unknown) => unknown) { return Promise.resolve({ data: filtered(), error: null }).then(res); },
      };
      const filtered = () => (tables[table] ?? []).filter((r) => (!("org_id" in rec.eq) || r.org_id === rec.eq.org_id) && (!rec.eq.doc_type || r.doc_type === rec.eq.doc_type) && (!inIds || inIds.includes(r.id as string)));
      return q;
    },
  };
  return { db: db as never, calls };
}
const NOW = new Date("2026-11-18T12:00:00Z");
const q = (org: string, id: string, over: Row = {}): Row => ({ org_id: org, id, quote_ref: `NQ-Q-${id}`, revision: 1, customer_name: `Cust ${id}`, site_name: "S", state: "REP_DRAFT", draft_hash: "h", estimator_signoff_hash: null, customer_confirmed_cents: 1000, contract_cents: null,
  project_id: null, requires_customer_acceptance: true, created_by_email: "rep@x.test", created_at: "2026-11-10T00:00:00Z", draft: emptyDraft(), accepted_baseline: null, ...over });
const tables = () => ({ newquip_quotes: [q(ORG, "1"), q(ORG, "2", { state: "ESTIMATOR_REVIEW", customer_confirmed_at: "2026-11-12T00:00:00Z" }), q(OTHER, "99", { customer_name: "OTHER ORG SECRET" })] });
const viewer = (over: Partial<ReportViewer> = {}): ReportViewer => ({ orgId: ORG, email: "x@x.test", roles: new Set(["rep"]), canSeeCost: false, ...over });

describe("organisation isolation", () => {
  it("every query is scoped to the viewer's organisation; another organisation's rows never appear", async () => {
    const { db, calls } = fakeDb(tables());
    const r = await pipelineReport(db, viewer(), {}, NOW);
    expect(JSON.stringify(r)).not.toContain("OTHER ORG SECRET"); expect(r.total).toBe(2);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.eq.org_id, `${c.table} must filter org_id`).toBe(ORG);
  });
});

describe("Rep cost-data exclusion", () => {
  it("the operational loader never selects a draft, baseline or cost column, so none can reach a Rep's payload", async () => {
    const { db, calls } = fakeDb(tables());
    await pipelineReport(db, viewer(), {}, NOW); await bottleneckReport(db, viewer(), {}, NOW);
    for (const c of calls) for (const bad of ["draft,", "draft ", "accepted_baseline", "internal", "cost_", "margin"]) expect(`${c.cols},`).not.toContain(bad.endsWith(",") ? bad : bad);
    expect(calls.some((c) => /\bdraft\b/.test(c.cols.replace("draft_hash", "")))).toBe(false);
  });
  it("a Rep's costing report is refused BEFORE any database read", async () => {
    const { db, calls } = fakeDb(tables());
    await expect(costingReport(db, viewer(), {}, NOW)).rejects.toThrow(/Estimators and Managers/);
    expect(calls).toHaveLength(0);
  });
  it("the costing loader refuses a caller without cost entitlement (second line of defence) without reading", async () => {
    const { db, calls } = fakeDb(tables());
    await expect(loadCostingRows(db, ORG, { canSeeCost: false }, ["1"])).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
  it("Rep exports carry no commercial column and no costing blockers", async () => {
    const { db } = fakeDb(tables());
    for (const kind of ["pipeline", "bottlenecks"] as const) {
      const { buffer } = await exportReport(db, viewer(), kind, {}, NOW);
      const text = (await readAll(buffer)).toLowerCase();
      for (const bad of ["margin", "supplier", "estimated cost", "gross profit", "costing blockers", "freight"]) expect(text).not.toContain(bad);
    }
    await expect(exportReport(db, viewer(), "costing", {}, NOW)).rejects.toThrow();
  });
});

describe("Estimator and Manager permissions", () => {
  it("an entitled viewer gets costing rows only for their own organisation, with the engine's labels", async () => {
    const { db, calls } = fakeDb(tables());
    const r = await costingReport(db, viewer({ roles: new Set(["estimator"]), canSeeCost: true }), {}, NOW);
    expect(r.total).toBe(2); expect(JSON.stringify(r)).not.toContain("OTHER ORG SECRET");
    for (const c of calls) expect(c.eq.org_id).toBe(ORG);
    expect(r.rows.every((x) => ["INDICATIVE", "UNAVAILABLE", "COSTED_UNVERIFIED", "VERIFIED", "APPROVED"].includes(x.basis))).toBe(true);
  });
  it("the Management Overview is built from the same single-row-per-quotation data", async () => {
    const { db } = fakeDb(tables());
    const { overview, filtered } = await overviewReport(db, viewer({ roles: new Set(["manager"]) }), {}, NOW);
    expect(filtered).toBe(2); expect(overview).toMatchObject({ total: 2, open: 2, awaitingRep: 1, awaitingEstimator: 1, indicativePipelineCents: 2000 });
  });
  it("'All outstanding' for a non-Manager is only their own role's queue", async () => {
    const { db } = fakeDb(tables());
    const asEst = await bottleneckReport(db, viewer({ email: "e@x.test", roles: new Set(["estimator"]) }), { view: "all" }, NOW);
    expect(asEst.rows.map((r) => r.id)).toEqual(["2"]);
    const asMgr = await bottleneckReport(db, viewer({ roles: new Set(["manager"]) }), { view: "all" }, NOW);
    expect(asMgr.total).toBe(2);
  });
});

describe("export accuracy", () => {
  it("the Manager's pipeline export has one row per displayed row, with ZAR (ex VAT) amounts equal to the cents shown", async () => {
    const { db } = fakeDb(tables());
    const v = viewer({ roles: new Set(["manager"]) });
    const page = await pipelineReport(db, v, {}, NOW);
    const { buffer, fileName } = await exportReport(db, v, "pipeline", {}, NOW);
    const ExcelJS = (await import("exceljs")).default; const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as never);
    const ws = wb.worksheets[0]; const header = ws.getRow(6).values as unknown[]; const col = (header as string[]).indexOf("Value ex VAT (ZAR)");
    const rows: number[] = []; ws.eachRow((r, n) => { if (n > 6) rows.push(r.getCell(col).value as number); });
    expect(rows).toHaveLength(page.total); expect(rows.reduce((a, b) => a + b, 0)).toBeCloseTo(page.valueCents / 100, 2);
    expect(fileName).toMatch(/^newquip-pipeline-2026-11-18\.xlsx$/); expect(String(ws.getRow(4).getCell(1).value)).toMatch(/EXCLUDING VAT/); expect(String(ws.getRow(2).getCell(1).value)).toMatch(/Generated: 2026\/11\/18/);
  });
});

async function readAll(buffer: Buffer): Promise<string> {
  const ExcelJS = (await import("exceljs")).default; const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer as never);
  const out: string[] = []; wb.worksheets.forEach((ws) => ws.eachRow((r) => r.eachCell((c) => out.push(String(c.value ?? "")))));
  return out.join("\n");
}
