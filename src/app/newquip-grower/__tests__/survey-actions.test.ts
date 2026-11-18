import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "../actor";

// The cost survey is READ-ONLY and cost-bearing: authority first, input validation, and nothing but reads reaches Cin7 or the database.
vi.mock("server-only", () => ({}));
const calls: string[] = [];
const query: Record<string, unknown[]> = { newquip_package_mappings: [{ lines: [{ sku: "KNQ160" }] }], newquip_quotes: [{ skus: { ERT053: {}, PNQ082: {} } }] };
vi.mock("@/supabase/server", () => ({
  createServiceRoleClient: () => ({ from: (t: string) => { calls.push(`from:${t}`); const q: Record<string, unknown> = { select: () => q, eq: () => q, order: () => q, limit: () => q, then: (ok: (v: unknown) => void) => ok(failTable === t ? { data: null, error: { message: "x" } } : { data: query[t] ?? [] }) }; return q; } }),
}));
let failTable: string | null = null;
let actor: Actor;
vi.mock("../actor", async (orig) => ({ ...(await orig<typeof import("../actor")>()), authoriseActor: vi.fn(async () => actor) }));
const read = vi.fn();
vi.mock("@/lib/projects/latest-cost-adapter", async (orig) => ({
  ...(await orig<typeof import("@/lib/projects/latest-cost-adapter")>()),
  listCin7Suppliers: vi.fn(async () => [{ id: "E1", name: "ERRA TECNI-RAM SL", currency: "EUR", active: true }]),
  readRawProductsForSurvey: (...a: unknown[]) => read(...a),
}));
import * as actions from "../survey-actions";

const asActor = (over: Partial<Actor> = {}): Actor => ({ orgId: "org-nq", userId: "u1", email: "e@nq", tier: "member", roles: new Set(["estimator"]) as never, canSeeCost: true, activeRole: null, demo: null, ...over } as Actor);
beforeEach(() => { actor = asActor(); calls.length = 0; failTable = null; read.mockReset(); });

describe("cost survey actions", () => {
  it("a Rep (no cost visibility) and Demo Mode are refused, and nothing is read", async () => {
    actor = asActor({ canSeeCost: false });
    expect((await actions.getCostSurveyUniverseAction()).ok).toBe(false);
    expect((await actions.surveyCin7SkusAction(["ERT053"])).ok).toBe(false);
    actor = asActor({ demo: {} as never });
    expect((await actions.surveyCin7SkusAction(["ERT053"])).ok).toBe(false);
    expect(read).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });
  it("the universe is the commercial mappings, saved package mappings and quotation SKUs, with where each came from; only reads touch the database", async () => {
    const r = await actions.getCostSurveyUniverseAction();
    expect(r.ok).toBe(true);
    expect(r.data!.sources.KNQ160).toContain("saved package mapping");
    expect(r.data!.sources.ERT053).toEqual(expect.arrayContaining(["commercial mapping", "existing quotation"]));
    expect(new Set(calls)).toEqual(new Set(["from:newquip_package_mappings", "from:newquip_quotes"]));
  });
  it("a failed database read fails the whole call (never a silently partial universe), and the cap is reported", async () => {
    failTable = "newquip_quotes";
    expect((await actions.getCostSurveyUniverseAction()).ok).toBe(false);
    failTable = null;
    expect((await actions.getCostSurveyUniverseAction()).data!.truncated).toBe(false);
  });
  it("classifies what Cin7 returns (ERT053 observed: EUR 26.8440995, last supplied 2026-11-13) and surfaces unit-like fields as evidence", async () => {
    read.mockResolvedValue({ ERT053: { raw: { SKU: "ERT053", Status: "Active", Name: "Mat", UOM: "Item", AverageCost: 494.46, Suppliers: [{ SupplierID: "E1", SupplierName: "ERRA TECNI-RAM SL", Cost: 26.8440995, LastSupplied: "2026-11-13T00:00:00Z", PurchaseUnit: "Box" }] } }, NOPE: { raw: null }, BAD: { error: "http_500" } });
    const r = await actions.surveyCin7SkusAction(["ERT053", "NOPE", "BAD"]);
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.data!.results.map((x) => [x.sku, x]));
    expect(by.ERT053).toMatchObject({ currency: "EUR", fxNeeded: true });
    expect(by.ERT053.selected).toMatchObject({ cost: 26.8440995, lastSupplied: "2026-11-13" });
    expect(by.NOPE.reasons).toEqual(["not_in_cin7"]);
    expect(r.data!.errors).toEqual({ BAD: "http_500" });
    expect(r.data!.inputs.find((i) => i.sku === "ERT053")!.unitFields).toMatchObject({ UOM: "Item", "supplier0.PurchaseUnit": "Box" });
  });
  it("the supplied-figure comparison is cost-entitled only and compares against what Cin7 returned", async () => {
    actor = asActor({ canSeeCost: false });
    expect((await actions.compareSuppliedCostsAction([])).ok).toBe(false);
    actor = asActor();
    const r = await actions.compareSuppliedCostsAction([{ sku: "NQ1017", found: true, cost: 3.14, currency: "ZAR", lastSupplied: "2026-11-13" }, { sku: "NQ1942", found: true, cost: null, currency: null, lastSupplied: null }]);
    expect(r.ok).toBe(true);
    const by = Object.fromEntries(r.data!.map((x) => [x.sku, x.status]));
    expect(by).toMatchObject({ NQ1017: "agrees", NQ1942: "cin7_has_no_cost", "NQ.TUBE.63": "not_in_cin7", NQ1163: "not_in_cin7" });
  });
  it("refuses a malformed or oversized request", async () => {
    expect((await actions.surveyCin7SkusAction([])).error).toBe("The request was not valid.");
    expect((await actions.surveyCin7SkusAction(Array.from({ length: 13 }, (_, i) => `S${i}`))).error).toBe("The request was not valid.");
    expect((await actions.surveyCin7SkusAction(["bad;sku"])).error).toBe("The request was not valid.");
    expect((await actions.surveyCin7SkusAction([" padded"])).error).toBe("The request was not valid.");
  });
});
