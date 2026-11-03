import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, loadQuote, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { rolesFor } from "@/newquip/quote/roles";
import { keepEstimatorOwnedFields } from "@/newquip/quote/draft-ownership";
import * as actions from "../actions";

// A Rep may edit Rep-owned fields of a saved draft (also after an Estimator return) but can NEVER change an Estimator-owned one, whatever the browser sends.
// And a Rep's response carries no margin / cost key at all (strict key scan, with an Estimator positive control).

let db: FakeDb;
vi.mock("@/lib/authorization", () => ({ requireModuleAccess: vi.fn() }));
vi.mock("@/lib/require-org-admin", () => ({ requireOrgAdmin: vi.fn() }));
vi.mock("@/newquip/require-newquip-poc-org", () => ({ requireNewquipPocOrg: vi.fn() }));
vi.mock("@/lib/approvals/role-store", () => ({ resolveRoles: vi.fn(), canSeeCosts: vi.fn() }));
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { testPriceSource: src } = await import("@/newquip/grower/__tests__/test-snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(), withholdCost }) };
});

const ORG = "org-nq";
const SESSION = { orgId: ORG, userId: "u1", email: "u@nq" };
const member = rolesFor("member");
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);
const stored = async (id: string) => (await loadQuote(db as never, ORG, id))!.draft;

beforeEach(() => {
  db = new FakeDb();
  seedGoldenCatalogue(db as never, ORG);
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
});

async function quote(): Promise<string> {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, readyDraft());
  return id;
}

describe("field-level ownership of a saved draft", () => {
  it("a Rep's save keeps every Estimator-owned field from the stored draft", async () => {
    const id = await quote();
    const before = await stored(id);
    const d = structuredClone(before);
    d.estimator.confirmedPackages = [];                                   // tampered
    d.estimator.costOverrides = { feeder: { lineCostCents: 1, reason: "x", by: "rep", at: "now" } };
    d.estimator.physicalCosts = { SKU1: { unitCostCents: 1, source: "MANUAL_ESTIMATE", retrievedAt: "now" } };
    d.estimator.costBasis = { incompleteAccepted: { reason: "forged", by: "rep", at: "now" } };
    const r = await actions.saveGrowerDraftAction(id, d);
    expect(r.error).toBeUndefined();
    const after = await stored(id);
    expect(after.estimator.confirmedPackages).toEqual(before.estimator.confirmedPackages);
    expect(after.estimator.confirmedMappings).toEqual(before.estimator.confirmedMappings);
    expect(after.estimator.priceResolutions).toEqual(before.estimator.priceResolutions);
    expect(after.estimator.costOverrides).toBeUndefined();
    expect(after.estimator.physicalCosts).toBeUndefined();
    expect(after.estimator.costBasis).toEqual(before.estimator.costBasis);
  });
  it("a Rep still cannot change a mapping or a manual price (the existing refusals are preserved)", async () => {
    const id = await quote();
    const d = structuredClone(await stored(id));
    d.estimator.confirmedMappings = { ...d.estimator.confirmedMappings, feeder: "OTHER" };
    expect((await actions.saveGrowerDraftAction(id, d)).error).toMatch(/Only an Estimator or Manager/);
    const e = structuredClone(await stored(id));
    e.estimator.priceResolutions = {};
    expect((await actions.saveGrowerDraftAction(id, e)).error).toMatch(/Only an Estimator or Manager/);
  });
  it("Rep-owned fields remain editable: quantities, exclusions, charges, the M75 price, assumptions, customer and site", async () => {
    const id = await quote();
    const d = structuredClone(await stored(id));
    d.config.estimatorQuantities = { ...d.config.estimatorQuantities, feeder: 15 };
    d.estimator.charges = { ...d.estimator.charges, delivery: 260_000 };
    d.estimator.unitPrices = { flex_auger: 160_000 };
    d.estimator.assumptions = "Rep note";
    d.siteName = "Warden 2";
    expect((await actions.saveGrowerDraftAction(id, d)).error).toBeUndefined();
    const after = await stored(id);
    expect(after.config.estimatorQuantities?.feeder).toBe(15);
    expect(after.estimator).toMatchObject({ charges: { delivery: 260_000 }, unitPrices: { flex_auger: 160_000 }, assumptions: "Rep note" });
    expect(after.siteName).toBe("Warden 2");
  });
  it("an Estimator keeps the current behaviour: it may confirm packages and map products", async () => {
    const id = await quote();
    asRoles("REP", "ESTIMATOR");
    const d = structuredClone(await stored(id));
    d.estimator.confirmedPackages = [];
    expect((await actions.saveGrowerDraftAction(id, d)).error).toBeUndefined();
    expect((await stored(id)).estimator.confirmedPackages).toEqual([]);
  });
  it("after an Estimator return (REP_DRAFT, revision + 1) the Rep edits Rep-owned fields only", async () => {
    const id = await quote();
    db.rows("newquip_quotes")[0].revision = 2;
    const d = structuredClone(await stored(id));
    d.estimator.assumptions = "after return"; d.estimator.confirmedPackages = [];
    expect((await actions.saveGrowerDraftAction(id, d)).error).toBeUndefined();
    const after = await stored(id);
    expect(after.estimator.assumptions).toBe("after return");
    expect(after.estimator.confirmedPackages).toEqual(readyDraft().estimator.confirmedPackages);
  });
  it("creating a quote as a Rep cannot smuggle Estimator-owned fields in either", async () => {
    const d = readyDraft(); d.estimator.confirmedMappings = {}; d.estimator.priceResolutions = {};
    const r = await actions.createGrowerQuoteAction(d);
    expect(r.ok).toBe(true);
    expect((await stored(r.data!.id)).estimator.confirmedPackages).toEqual([]);
  });
  it("MUTATION CONTROL: keepEstimatorOwnedFields is the thing doing the work (a no-op scoping would let a Rep overwrite the packages)", () => {
    const prior = readyDraft(); const sent = structuredClone(prior); sent.estimator.confirmedPackages = [];
    expect(keepEstimatorOwnedFields(sent, prior, new Set(["rep"])).estimator.confirmedPackages).toEqual(prior.estimator.confirmedPackages);
    expect(keepEstimatorOwnedFields(sent, prior, new Set(["rep", "estimator"])).estimator.confirmedPackages).toEqual([]);
  });
});

describe("a Rep response carries no margin or cost-derived key", () => {
  const keysOf = (v: unknown, out = new Map<string, unknown[]>()): Map<string, unknown[]> => {
    if (Array.isArray(v)) v.forEach((x) => keysOf(x, out));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.set(k, [...(out.get(k) ?? []), x]); keysOf(x, out); }
    return out;
  };
  const NEVER_PRESENT = ["marginRevenueExTax", "costedLineCount", "excludedFromMarginCount", "internalMargin", "physicalCostEstimate", "costOverrides", "physicalCosts", "costBasis", "landedCostExVat", "landedCost"];
  const ZERO_OR_NULL = ["estimatedCost", "estimatedGP", "marginPct", "overallMarginPct"];

  it("the Rep's get / preview responses have none of the keys; an Estimator-with-cost response has them (positive control)", async () => {
    const id = await quote();
    const rep = await actions.getGrowerQuoteAction(id);
    const prev = await actions.previewGrowerDraftAction(await stored(id));
    for (const data of [rep.data, prev.data]) {
      const k = keysOf(data);
      for (const n of NEVER_PRESENT) expect(k.has(n), `Rep response has ${n}`).toBe(false);
      for (const n of ZERO_OR_NULL) for (const v of k.get(n) ?? []) expect(v === null || v === 0, `${n}=${String(v)}`).toBe(true);
    }
    const m = /.{60}landed.{40}/i.exec(JSON.stringify(rep.data)); expect(m?.[0]).toBeUndefined();

    asRoles("REP", "ESTIMATOR", "MANAGER");
    vi.mocked(canSeeCosts).mockResolvedValue(true);
    const mgr = keysOf((await actions.getGrowerQuoteAction(id)).data);
    expect(mgr.has("marginRevenueExTax")).toBe(true);
    expect(mgr.has("costedLineCount")).toBe(true);
    expect((mgr.get("costedLineCount") ?? []).some((v) => typeof v === "number" && v > 0)).toBe(true);
    expect((mgr.get("estimatedCost") ?? []).some((v) => typeof v === "number" && v > 0)).toBe(true);
  });
});
