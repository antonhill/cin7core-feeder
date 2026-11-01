import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { createQuote, estimatorSignOff, loadQuote, saveDraft, sendToEstimator } from "@/lib/newquip-quotes/quote-store";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { expectedSkuFor } from "@/newquip/grower/quote-bridge";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { rolesFor } from "@/newquip/quote/roles";
import * as actions from "../actions";

// Product mappings decide what a quotation is built from. NEGATIVE authorisation: a Rep (functional role REP only) cannot change ANY mapping, on create or on save,
// including the non-optional ones; an Estimator/Manager can. And mapping integrity is re-verified at estimator sign-off against the live catalogue.

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
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member");
const asRoles = (...r: Array<"REP" | "ESTIMATOR" | "MANAGER">) => vi.mocked(resolveRoles).mockResolvedValue(new Set(r) as never);

beforeEach(() => {
  db = new FakeDb();
  seedGoldenCatalogue(db as never, ORG, [{ sku: "DOOR-NEW" }, { sku: "OPT-INACTIVE", active: false }]);
  vi.clearAllMocks();
  vi.mocked(requireNewquipPocOrg).mockResolvedValue(SESSION as never);
  vi.mocked(requireModuleAccess).mockResolvedValue(SESSION as never);
  vi.mocked(requireOrgAdmin).mockRejectedValue(new Error("not admin"));
  vi.mocked(canSeeCosts).mockResolvedValue(false);
  asRoles("REP");
});

async function storedQuote() {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, readyDraft());
  return id;
}
const mapped = async (id: string) => (await loadQuote(db as never, ORG, id))!.draft.estimator.confirmedMappings;

describe("a Rep cannot change a product mapping", () => {
  it("not a non-optional one (pvc_door), not the source-backed ones, not an optional one — each is refused and nothing is stored", async () => {
    const id = await storedQuote();
    const before = await mapped(id);
    for (const [key, sku] of [["pvc_door", "DOOR-NEW"], ["bulk_tank", expectedSkuFor("bulk_tank")!], ["controller", "DOOR-NEW"]] as const) {
      const d = readyDraft();
      d.estimator.confirmedMappings = { ...d.estimator.confirmedMappings, [key]: sku };
      if (d.estimator.confirmedMappings[key] === before[key as keyof typeof before]) delete d.estimator.confirmedMappings[key]; // a genuine change either way
      const r = await actions.saveGrowerDraftAction(id, d);
      expect(r.ok, key).toBe(false);
      expect(r.error, key).toMatch(/Only an Estimator or Manager can map a product/);
    }
    expect(await mapped(id)).toEqual(before);
  });
  it("cannot remove an existing confirmation either", async () => {
    const id = await storedQuote();
    const d = readyDraft();
    delete d.estimator.confirmedMappings.pvc_door;
    expect((await actions.saveGrowerDraftAction(id, d)).error).toMatch(/Only an Estimator or Manager/);
  });
  it("cannot smuggle mappings in through quote CREATE", async () => {
    const r = await actions.createGrowerQuoteAction(readyDraft());
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Only an Estimator or Manager/);
    expect(db.rows("newquip_quotes")).toHaveLength(0);
  });
  it("a Rep can still save an unrelated edit when the mappings are unchanged", async () => {
    const id = await storedQuote();
    const d = readyDraft();
    d.estimator.assumptions = "Rep note";
    expect((await actions.saveGrowerDraftAction(id, d)).ok).toBe(true);
  });
  it("a Rep can still create a quote without mappings", async () => {
    expect((await actions.createGrowerQuoteAction()).ok).toBe(true);
  });
});

describe("an Estimator/Manager can map, within catalogue integrity", () => {
  it("an Estimator may change pvc_door to an active catalogue product", async () => {
    asRoles("REP", "ESTIMATOR");
    const id = await storedQuote();
    const d = readyDraft();
    d.estimator.confirmedMappings.pvc_door = "DOOR-NEW";
    expect((await actions.saveGrowerDraftAction(id, d)).ok).toBe(true);
    expect((await mapped(id)).pvc_door).toBe("DOOR-NEW");
  });
  it("is refused for a SKU not in the catalogue, an inactive one, a wrong source-backed SKU and an unknown slot", async () => {
    asRoles("REP", "ESTIMATOR", "MANAGER");
    const id = await storedQuote();
    const attempt = async (key: string, sku: string) => { const d = readyDraft(); (d.estimator.confirmedMappings as Record<string, string>)[key] = sku; return (await actions.saveGrowerDraftAction(id, d)).error ?? ""; };
    expect(await attempt("pvc_door", "NOT-A-PRODUCT")).toMatch(/not in the synced Cin7 catalogue/);
    expect(await attempt("controller", "OPT-INACTIVE")).toMatch(/inactive/);
    expect(await attempt("bulk_tank", "DOOR-NEW")).toMatch(/source-backed/);
    // an unknown slot is dropped by normalisation, never stored
    const d = readyDraft();
    (d.estimator.confirmedMappings as Record<string, string>).made_up = "DOOR-NEW";
    expect((await actions.saveGrowerDraftAction(id, d)).ok).toBe(true);
    expect(Object.keys(await mapped(id))).not.toContain("made_up");
  });
  it("a mapping that was fine and later goes inactive does not block an unrelated save (only new or changed mappings are verified on save)", async () => {
    asRoles("REP", "ESTIMATOR");
    const id = await storedQuote();
    for (const p of db.rows("products")) if (p.sku === "NQ2114") p.active = false;
    const d = readyDraft();
    d.estimator.assumptions = "later edit";
    expect((await actions.saveGrowerDraftAction(id, d)).ok).toBe(true);
  });
});

describe("mapping integrity is re-verified at estimator sign-off", () => {
  async function inReview() {
    const id = await storedQuote();
    const total = evaluateDraft(readyDraft(), ctx).budget!.totals.subtotalExTax;
    await sendToEstimator(db as never, ORG, member, "rep@nq", id, ctx, { confirmedAmountCents: Math.round(total * 100), confirmedBy: "Joe" });
    return id;
  }
  const deactivate = (sku: string, active: boolean | null) => { for (const p of db.rows("products")) if (p.sku === sku) p.active = active; };

  it("a mapped product deactivated AFTER the draft was saved blocks sign-off, and nothing is stamped", async () => {
    const id = await inReview();
    deactivate("NQ2114", false);
    await expect(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx)).rejects.toThrow(/Cannot sign off: NQ2114 is inactive/);
    expect((await loadQuote(db as never, ORG, id))!.estimator_signoff_hash).toBeNull();
  });
  it("a mapped product removed from the catalogue blocks sign-off", async () => {
    const id = await inReview();
    db.tables["products"] = db.rows("products").filter((p) => p.sku !== "SYSH-2750-3");
    await expect(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx)).rejects.toThrow(/SYSH-2750-3 is not in the synced Cin7 catalogue/);
  });
  it("a catalogue row belonging to ANOTHER organisation does not satisfy the check", async () => {
    const id = await inReview();
    for (const p of db.rows("products")) if (p.sku === "NQ1161") p.org_id = "org-other";
    await expect(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx)).rejects.toThrow(/NQ1161 is not in the synced Cin7 catalogue/);
  });
  it("an unreadable catalogue fails closed", async () => {
    const id = await inReview();
    const real = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (t: string) => (t === "products" ? { select: () => ({ eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: "boom" } }) }) }) } : real(t));
    await expect(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx)).rejects.toThrow(/could not be verified/);
  });
  it("with an intact catalogue sign-off succeeds, and already-approved quotations are not re-checked (approval never calls the check)", async () => {
    const id = await inReview();
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    expect((await loadQuote(db as never, ORG, id))!.estimator_signoff_hash).not.toBeNull();
    const src = (await import("node:fs")).readFileSync(new URL("../../../lib/newquip-quotes/quote-store.ts", import.meta.url), "utf8");
    const approve = src.slice(src.indexOf("export async function managerApprove("), src.indexOf("export async function managerApprove(") + 1500);
    expect(approve).not.toMatch(/verifyMappings/);
  });
});
