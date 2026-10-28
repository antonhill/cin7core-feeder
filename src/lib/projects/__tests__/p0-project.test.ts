import { beforeEach, describe, expect, it } from "vitest";
import { FakeDb } from "./fake-db";
import { goldenFixtureBaseline } from "../baseline";
import { createProjectFromBaseline, loadProjectView } from "../project-store";
import { buildP0Baseline, isP0Disposable, P0_DEFAULT_SCHEDULE, type P0ProjectInput } from "../p0-project";
import { createP0Project, searchStockedProducts } from "../p0-project-store";
import { runP0, type P0Port } from "../p0-checklist";
import { NEWQUIP_POC_CIN7_INSTANCE_ID, OPERATIONAL_CUSTOMER_DENYLIST } from "@/newquip/access";
import { NEWQUIP_REQUIRED_SUPABASE_REF } from "../write-flag";

const ORG = "org-a";
const DENY = OPERATIONAL_CUSTOMER_DENYLIST;
const input = (o: Partial<P0ProjectInput> = {}): P0ProjectInput => ({ customerName: "NQ P0 Test Customer", products: [{ sku: "NQ1173", name: "FLAT WASHER M8 (SST)", quantity: 2 }], contractRands: "100000", schedule: P0_DEFAULT_SCHEDULE, ...o });

describe("P0 baseline (pure)", () => {
  it("separates the test contract and milestone schedule from product values: products are quantity-only at R0", () => {
    const r = buildP0Baseline("P0-1", input({ products: [{ sku: "NQ1173", name: "W", quantity: 2 }, { sku: "KNQ213", name: "C", quantity: 5 }] }), DENY);
    if (!r.ok) throw new Error(r.error);
    expect(r.baseline.contractCents).toBe(10_000_000);
    expect(r.stages).toEqual([{ name: "Deposit", valueCents: 1_000_000 }, { name: "Manufacturing", valueCents: 6_000_000 }, { name: "Delivery", valueCents: 3_000_000 }]);
    expect(r.stages.reduce((n, s) => n + s.valueCents, 0)).toBe(r.baseline.contractCents);
    expect(r.baseline.lines.map((l) => [l.sku, l.quantity, l.salesValueCents, l.estimatedCostCents, l.suggestedStageName])).toEqual([["NQ1173", 2, 0, null, null], ["KNQ213", 5, 0, null, null]]);
    expect(r.baseline.taxRateBps).toBe(1500);
    expect(isP0Disposable(r.baseline.sourceQuoteRef)).toBe(true);
  });
  it("splits an awkward contract into whole cents that still sum exactly", () => {
    const r = buildP0Baseline("P0-1", input({ contractRands: "100000.01", schedule: [{ name: "A", percent: "33.33" }, { name: "B", percent: "33.33" }, { name: "C", percent: "33.34" }] }), DENY);
    if (!r.ok) throw new Error(r.error);
    expect(r.stages.reduce((n, s) => n + s.valueCents, 0)).toBe(10_000_001);
  });
  it("fails closed: no products, too many, duplicates, bad quantities, bad contract, bad schedule, operational customer", () => {
    const bad = (o: Partial<P0ProjectInput>) => { const r = buildP0Baseline("P0-1", input(o), DENY); return r.ok ? null : r.error; };
    expect(bad({ products: [] })).toMatch(/at least one/);
    const p = (sku: string) => ({ sku, name: sku, quantity: 1 });
    expect(bad({ products: [p("A"), p("B"), p("C")] })).toMatch(/at most 2/);
    expect(bad({ products: [p("A"), p("A")] })).toMatch(/twice/);
    expect(bad({ products: [{ sku: "A", name: "A", quantity: 1.5 }] })).toMatch(/positive whole/);
    expect(bad({ products: [{ sku: "A", name: "A", quantity: 0 }] })).toMatch(/positive whole/);
    expect(bad({ products: [{ sku: " ", name: "A", quantity: 1 }] })).toMatch(/missing/);
    expect(bad({ contractRands: "0" })).toMatch(/greater than zero/);
    expect(bad({ contractRands: "-5" })).toBeTruthy();
    expect(bad({ contractRands: "abc" })).toBeTruthy();
    expect(bad({ schedule: [{ name: "A", percent: "50" }] })).toMatch(/100%/);
    expect(bad({ schedule: [] })).toBeTruthy();
    expect(bad({ customerName: " " })).toMatch(/customer/);
    expect(bad({ customerName: "Afgri Farms" })).toMatch(/operational customer/);
  });
});

function rows(db: FakeDb, over: Array<Record<string, unknown>> = []) {
  const base = [
    { product_sku: "NQ1173", product_name: "FLAT WASHER M8 (SST)", location: "MSTR", on_hand: "27300", available: "27300", synced_at: "2026-10-28T08:00:00Z" },
    { product_sku: "KNQ213", product_name: "STEEL SUSPENSION CLAMP", location: "MSTR", on_hand: "13381", available: "11381", synced_at: "2026-10-28T08:00:00Z" },
    { product_sku: "KNQ213", product_name: "STEEL SUSPENSION CLAMP", location: "MSTR", on_hand: "10", available: "5", synced_at: "2026-10-28T08:00:00Z" },
    { product_sku: "ZERO", product_name: "NO STOCK", location: "MSTR", on_hand: "5", available: "0", synced_at: "x" },
    { product_sku: "NULLQ", product_name: "UNKNOWN", location: "MSTR", on_hand: null, available: null, synced_at: "x" },
    { product_sku: "ELSEWHERE", product_name: "OTHER LOC", location: "PROJ", on_hand: "9", available: "9", synced_at: "x" },
    ...over,
  ];
  for (const r of base) db.rows("product_availability").push({ org_id: ORG, ...r });
  db.rows("product_availability").push({ org_id: "org-b", product_sku: "FOREIGN", product_name: "x", location: "MSTR", on_hand: "1", available: "1", synced_at: "x" });
}

describe("catalogue search (local cache)", () => {
  it("offers only existing products with positive free stock at the location, for this org, summed per SKU, most stock first", async () => {
    const db = new FakeDb(); rows(db);
    const all = await searchStockedProducts(db as never, ORG, "MSTR", "");
    expect(all.map((p) => [p.sku, p.available])).toEqual([["NQ1173", 27300], ["KNQ213", 11386]]);
    expect((await searchStockedProducts(db as never, ORG, "MSTR", "clamp")).map((p) => p.sku)).toEqual(["KNQ213"]);
    expect((await searchStockedProducts(db as never, ORG, "MSTR", "nq11")).map((p) => p.sku)).toEqual(["NQ1173"]);
    expect(await searchStockedProducts(db as never, ORG, "NOWHERE", "")).toEqual([]);
    expect((await searchStockedProducts(db as never, ORG, "MSTR", "")).some((p) => ["ZERO", "NULLQ", "ELSEWHERE", "FOREIGN"].includes(p.sku))).toBe(false);
    await expect(searchStockedProducts(db as never, ORG, " ", "")).rejects.toThrow(/location/);
  });
});

class Port implements Pick<P0Port, "resolveProducts" | "stockAt"> {
  skus = new Set(["NQ1173", "KNQ213"]);
  stock: Record<string, Array<{ location: string | null; available: number | null }>> = { NQ1173: [{ location: "MSTR", available: 27300 }], KNQ213: [{ location: "MSTR", available: 11381 }] };
  async resolveProducts(s: string[]) { const ids = new Map<string, string>(); const missing: string[] = []; for (const k of s) { if (this.skus.has(k)) ids.set(k, "id"); else missing.push(k); } return { ids, missing }; }
  async stockAt(k: string) { return this.stock[k] ?? []; }
}
const err = async (p: Promise<unknown>) => { try { await p; } catch (e) { return (e as Error).message; } return undefined; };

describe("creating the disposable P0 project", () => {
  let db: FakeDb; let port: Port; let demoId: string;
  const create = (o: Partial<P0ProjectInput & { location: string }> = {}, gates = { isManager: true }) => createP0Project(db as never, port, gates, "m@x", DENY, { orgId: ORG, location: "MSTR", now: new Date("2026-10-28T10:00:00Z"), ...input(), ...o });
  beforeEach(async () => { db = new FakeDb(); port = new Port(); demoId = await createProjectFromBaseline(db as never, ORG, "m@x", goldenFixtureBaseline(), { reference: "PRJ-NQ-Q-0001", name: "Demo" }); });

  it("creates a separate ACTIVE project with real SKUs at R0, a test contract and a balanced milestone schedule, and leaves every existing row untouched", async () => {
    const demoBefore = JSON.stringify(db.rows("projects").find((p) => p.id === demoId));
    const stagesBefore = JSON.stringify(db.rows("project_stages").filter((s) => s.project_id === demoId));
    const writes = db.writes.length;
    const r = await create();
    expect(r.reference).toBe("P0-20261028-1");
    const view = (await loadProjectView(db as never, ORG, r.projectId))!;
    expect(view.project).toMatchObject({ status: "ACTIVE", original_contract_cents: 10_000_000, customer_name: "NQ P0 Test Customer" });
    expect(isP0Disposable(view.project.originating_quote_ref)).toBe(true);
    expect(view.stages.map((s) => s.valueCents)).toEqual([1_000_000, 6_000_000, 3_000_000]);
    expect(view.commercial.scheduleBalanced).toBe(true);
    const snap = db.rows("projects").find((p) => p.id === r.projectId)!.baseline_snapshot as { lines: Array<{ sku: string; quantity: number; salesValueCents: number }> };
    expect(snap.lines).toMatchObject([{ sku: "NQ1173", quantity: 2, salesValueCents: 0 }]);
    // the existing demonstration project is byte-identical, and only the new project's own rows were written
    expect(JSON.stringify(db.rows("projects").find((p) => p.id === demoId))).toBe(demoBefore);
    expect(JSON.stringify(db.rows("project_stages").filter((s) => s.project_id === demoId))).toBe(stagesBefore);
    expect(db.rows("projects")).toHaveLength(2);
    expect(db.writes.slice(writes).every((w) => ["projects", "project_stages", "project_stage_allocations"].includes(w.table))).toBe(true);
    expect(db.rows("newquip_quotes")).toHaveLength(0);
    expect(db.rows("project_cin7_sale_links")).toHaveLength(0);
  });
  it("a repeat creates a distinct project with the next reference, never a duplicate of the first", async () => {
    const a = await create(); const b = await create();
    expect([a.reference, b.reference]).toEqual(["P0-20261028-1", "P0-20261028-2"]);
    expect(a.projectId).not.toBe(b.projectId);
  });
  it("refuses, storing nothing, when a SKU is not in Cin7, stock is missing/short/unreadable, the user is not a manager, or the customer is operational", async () => {
    const n = () => db.rows("projects").length;
    const start = n();
    expect(await err(create({ products: [{ sku: "NOPE", name: "x", quantity: 1 }] }))).toMatch(/do not exist in Cin7: NOPE/);
    expect(await err(create({ products: [{ sku: "NQ1173", name: "x", quantity: 27301 }] }))).toMatch(/27300 available.*27301 needed/);
    expect(await err(create({ location: "ELSEWHERE" }))).toMatch(/no stock row at "ELSEWHERE"/);
    port.stock.NQ1173 = [{ location: "MSTR", available: null }];
    expect(await err(create())).toMatch(/unreadable/);
    port.stock.NQ1173 = [{ location: "MSTR", available: 100 }];
    expect(await err(create({}, { isManager: false }))).toMatch(/manager/);
    expect(await err(create({ customerName: "AGRICO" }))).toMatch(/operational customer/);
    expect(await err(create({ location: " " }))).toMatch(/location/);
    expect(n()).toBe(start);
  });
  it("the cached list is only a starting point: stock is re-verified live from the port at creation", async () => {
    rows(db);
    const offered = (await searchStockedProducts(db as never, ORG, "MSTR", "")).find((p) => p.sku === "NQ1173")!;
    expect(offered.available).toBe(27300);
    port.stock.NQ1173 = [{ location: "MSTR", available: 1 }]; // live stock has since gone
    expect(await err(create())).toMatch(/1 available.*2 needed/);
  });
  it("P0 then passes every AUTOMATED check for the created project's SKUs and quantities (with a correctly set-up customer)", async () => {
    const r = await create({ products: [{ sku: "NQ1173", name: "W", quantity: 2 }, { sku: "KNQ213", name: "C", quantity: 3 }] });
    const proj = db.rows("projects").find((p) => p.id === r.projectId)!;
    const snap = proj.baseline_snapshot as { lines: Array<{ sku: string; quantity: number }> };
    const url = `https://${NEWQUIP_REQUIRED_SUPABASE_REF}.supabase.co`;
    const p0port: P0Port = {
      customerExists: async (n) => n === "NQ P0 Test Customer",
      customerDefaults: async () => ({ taxRule: "Standard Rate Sales", revenueAccount: "200", location: "MSTR" }),
      resolveProducts: port.resolveProducts.bind(port), assemblySkus: async () => [], stockAt: port.stockAt.bind(port), findByExternalId: async () => [],
    };
    const report = await runP0({ env: { SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_URL: url, VERCEL_ENV: "preview" }, instances: [{ id: NEWQUIP_POC_CIN7_INSTANCE_ID, name: "NewQuip POC" }], expectedInstanceId: NEWQUIP_POC_CIN7_INSTANCE_ID, denylist: DENY, portFor: () => p0port },
      { customerName: proj.customer_name as string, location: "MSTR", taxRule: "Standard Rate Sales", revenueAccount: "200", skus: snap.lines.map((l) => ({ sku: l.sku, quantity: l.quantity })), externalId: `NEWQUIP-PROJECTS-SALE:${proj.project_reference as string}` });
    expect(report.counts).toMatchObject({ FAIL: 0, NOT_RUN: 0 });
    expect(report.verdict).toBe("READY_PENDING_MANUAL");
  });
});
