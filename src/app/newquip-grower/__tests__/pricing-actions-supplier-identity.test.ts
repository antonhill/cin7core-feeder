import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { micro } from "@/newquip/pricing/model";
import type { PricingSubmission } from "@/newquip/pricing/estimator/apply";
import { equivalentInputs, evidenceItemsFor, itemsOf } from "@/newquip/pricing/estimator/__tests__/helpers";
import { createQuote, loadQuote, saveDraft, sendToEstimator } from "@/lib/newquip-quotes/quote-store";
import { listPricingRevisions } from "@/lib/newquip-quotes/pricing-store";
import type { Actor } from "../actor";
import * as actions from "../pricing-actions";

// SUPPLIER IDENTITY at the server action: a NEW or CHANGED supplier cost must name an active Cin7 supplier by id, with the currency from that supplier's Cin7 record (or a reasoned override where Cin7 holds none).
// The Cin7 reads are replaced by controllable fakes; the rule, the action and the stored revision are the real ones.
vi.mock("server-only", () => ({}));
let db: FakeDb;
let actor: Actor;
vi.mock("@/supabase/server", () => ({ createServiceRoleClient: () => db }));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));
vi.mock("../actor", async (orig) => ({ ...(await orig<typeof import("../actor")>()), authoriseActor: vi.fn(async () => actor), auditActor: vi.fn(async () => undefined) }));
vi.mock("@/lib/newquip-quotes/context", async () => {
  const { testPriceSource: src } = await import("@/newquip/grower/__tests__/test-snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(), withholdCost }) };
});

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const asActor = (email: string, roles: Array<"rep" | "estimator" | "manager">, over: Partial<Actor> = {}): Actor => ({ orgId: ORG, userId: `u-${email}`, email, tier: roles.includes("manager") ? "admin" : "member", roles: new Set(roles), canSeeCost: true, activeRole: null, demo: null, ...over });
const EST = () => asActor("est@nq", ["rep", "estimator"]);
const MGR_ONLY = () => asActor("mgr@nq", ["manager"]);
const loaded = async (id: string) => (await loadQuote(db as never, ORG, id))!;
const submissionOf = (over: Partial<PricingSubmission> = {}): PricingSubmission => {
  const s = structuredClone(equivalentInputs({}, "unverified"));
  return { ruleVersionId: s.ruleVersionId, skus: Object.fromEntries(Object.entries(s.skus).map(([k, v]) => { const { by: _b, at: _a, ...rest } = v!; void _b; void _a; return [k, rest as never]; })), fxQuotes: s.fxQuotes as never, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null, ...over };
};
async function inReview(): Promise<string> {
  const d = readyDraft();
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100), confirmedBy: "Farmer Joe" });
  return id;
}
const state = async (id: string) => ({ hash: (await loaded(id)).draft_hash, pricing: JSON.stringify((await loaded(id)).draft.estimator.pricing ?? null), revisions: (await listPricingRevisions(db as never, ORG, id)).length });

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; seedGoldenCatalogue(db as never, ORG); actor = EST(); });


// Cin7 fakes: supplier ids encode their currency (CUR-EUR holds EUR); NOCUR has no currency; DOWN simulates an unreadable Cin7.
let down = false;
const SUPPLIERS: Record<string, { id: string; name: string; currency: string | null; active: boolean }> = {
  "CUR-EUR": { id: "CUR-EUR", name: "Cin7 Supplier EUR", currency: "EUR", active: true }, "CUR-USD": { id: "CUR-USD", name: "Cin7 Supplier USD", currency: "USD", active: true }, "CUR-ZAR": { id: "CUR-ZAR", name: "Cin7 Supplier ZAR", currency: "ZAR", active: true },
  NOCUR: { id: "NOCUR", name: "No Currency Co", currency: null, active: true },
};
vi.mock("@/lib/projects/latest-cost-adapter", () => ({
  cin7IdentityLookups: () => ({
    supplier: async (id: string) => (down ? { status: "unavailable" } : { status: "ok", value: SUPPLIERS[id] ?? null }),
    productSuppliers: async () => (down ? { status: "unavailable" } : { status: "ok", value: [] }),
  }),
}));

/** Every product of the fixture submission, attributed to a Cin7 supplier that holds its currency; `mutate` adjusts the first product. */
const withIdentity = (mutate?: (e: Record<string, unknown>) => void): PricingSubmission => {
  const s = submissionOf();
  const first = Object.keys(s.skus)[0];
  for (const [k, v] of Object.entries(s.skus)) {
    const e = v as unknown as Record<string, unknown>;
    e.supplierId = `CUR-${e.currency}`; e.supplierName = `Cin7 Supplier ${e.currency}`; e.currencySource = "cin7_supplier"; e.costKind = "manual_estimate"; e.costDate = null;
    if (k === first) mutate?.(e);
  }
  return s;
};
const rowOf = async (id: string, sku: string) => (await actions.getEstimatorPricingAction(id)).data!.view.rows.find((r) => r.sku === sku)!;

beforeEach(() => { down = false; });

describe("a new supplier cost needs a Cin7 supplier id and a Cin7-derived currency", () => {
  it("a cost typed with no supplier id (a free-text supplier) is refused and nothing is written", async () => {
    const id = await inReview();
    const before = await state(id);
    const free = submissionOf();
    for (const v of Object.values(free.skus)) { const e = v as unknown as Record<string, unknown>; e.supplierId = null; e.supplierName = "Some supplier typed by hand"; }
    const r = await actions.applyEstimatorPricingAction(id, free, "Initial supplier pricing", null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/choose the supplier from Cin7/);
    expect(await state(id)).toEqual(before);
  });

  it("is accepted with a Cin7 supplier whose currency is Cin7's, and the id, currency basis and kind survive save and reload", async () => {
    const id = await inReview();
    const sub = withIdentity();
    const sku = Object.keys(sub.skus)[0];
    const cur = (sub.skus[sku] as { currency: string }).currency;
    expect((await actions.applyEstimatorPricingAction(id, sub, "Initial supplier pricing", null)).ok).toBe(true);
    const row = await rowOf(id, sku);
    expect(row.supplierId).toBe(`CUR-${cur}`);
    expect(row.supplier).toBe(`Cin7 Supplier ${cur}`);
    expect(row.currency).toBe(cur);
    expect(row.currencySource).toBe("cin7_supplier");
    expect(row.costKind).toBe("manual_estimate");
  });

  it("a currency that is not the supplier's Cin7 currency is refused, so the Estimator cannot type a different one", async () => {
    const id = await inReview();
    const sub = withIdentity((e) => { e.currency = e.currency === "EUR" ? "USD" : "EUR"; });
    const r = await actions.applyEstimatorPricingAction(id, sub, "Supplier pricing from Cin7", null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Cin7 holds .* for Cin7 Supplier .*, not /);
  });

  it("when Cin7 holds NO currency the derived path is refused (never silently ZAR); a reasoned override is accepted, recorded and shown", async () => {
    const id = await inReview();
    const first = Object.keys(submissionOf().skus)[0];
    const derived = withIdentity((e) => { e.supplierId = "NOCUR"; e.supplierName = "No Currency Co"; e.currency = "ZAR"; });
    const r1 = await actions.applyEstimatorPricingAction(id, derived, "Supplier pricing from Cin7", null);
    expect(r1.ok).toBe(false);
    expect(r1.error).toMatch(/Cin7 holds no currency for No Currency Co/);
    const overridden = withIdentity((e) => { e.supplierId = "NOCUR"; e.supplierName = "No Currency Co"; e.currency = "ZAR"; e.currencySource = "override"; e.currencyOverrideReason = "Cin7 supplier record has no currency; the supplier invoices in rand."; });
    expect((await actions.applyEstimatorPricingAction(id, overridden, "Supplier pricing from Cin7", null)).ok).toBe(true);
    const row = await rowOf(id, first);
    expect(row.currencySource).toBe("override");
    expect(row.currencyOverrideReason).toMatch(/invoices in rand/);
  });

  it("an override with no reason is refused", async () => {
    const id = await inReview();
    const sub = withIdentity((e) => { e.supplierId = "NOCUR"; e.supplierName = "No Currency Co"; e.currency = "ZAR"; e.currencySource = "override"; e.currencyOverrideReason = "short"; });
    expect((await actions.applyEstimatorPricingAction(id, sub, "Supplier pricing from Cin7", null)).error).toMatch(/needs a reason/);
  });

  it("an unknown supplier id is refused", async () => {
    const id = await inReview();
    expect((await actions.applyEstimatorPricingAction(id, withIdentity((e) => { e.supplierId = "FREETEXT"; }), "Supplier pricing from Cin7", null)).error).toMatch(/not an active supplier in Cin7/);
  });

  it("when Cin7 cannot be read nothing is saved and the message says so (no guess in either direction)", async () => {
    const id = await inReview();
    down = true;
    const before = await state(id);
    const r = await actions.applyEstimatorPricingAction(id, withIdentity(), "Supplier pricing from Cin7", null);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/could not be read just now/);
    expect(await state(id)).toEqual(before);
  });
});

describe("changing the supplier of a saved cost", () => {
  it("is re-checked, and changes the cost's hash so an earlier independent verification stops applying", async () => {
    const id = await inReview();
    const first = Object.keys(submissionOf().skus)[0];
    expect((await actions.applyEstimatorPricingAction(id, withIdentity(), "Initial supplier pricing", null)).ok).toBe(true);
    const before = await rowOf(id, first);
    const base = withIdentity();
    const changed = withIdentity((e) => { e.supplierId = "CUR-USD"; e.supplierName = "Cin7 Supplier USD"; e.currency = "USD"; });
    const res = await actions.applyEstimatorPricingAction(id, changed, "Change supplier", base);
    if ((before.currency ?? "") === "USD") return; // the fixture's first product is already USD: nothing to compare
    expect(res.ok).toBe(true);
    const after = await rowOf(id, first);
    expect(after.supplierId).toBe("CUR-USD");
    expect(after.costHash).not.toBe(before.costHash);
  });
});

describe("role permissions are unchanged", () => {
  it("a Manager-only session still cannot enter a supplier cost, even a valid one", async () => {
    const id = await inReview();
    const before = await state(id);
    actor = MGR_ONLY();
    expect(await actions.applyEstimatorPricingAction(id, withIdentity(), "Manager edit", null)).toMatchObject({ ok: false, error: expect.stringMatching(/Only an Estimator/) });
    expect(await state(id)).toEqual(before);
  });
});
describe("a forged base cannot admit an unvalidated cost", () => {
  it("a submission whose base is the submission itself (so nothing looks 'changed') stores nothing new: the free-text cost never reaches the quotation", async () => {
    const id = await inReview();
    const free = submissionOf();
    for (const v of Object.values(free.skus)) { const e = v as unknown as Record<string, unknown>; e.supplierId = null; e.supplierName = "Typed by hand"; }
    const before = await state(id);
    await actions.applyEstimatorPricingAction(id, free, "Initial supplier pricing", structuredClone(free));
    const after = await loaded(id);
    expect(JSON.stringify(after.draft.estimator.pricing ?? null)).not.toContain("Typed by hand");
    expect((await state(id)).revisions).toBeLessThanOrEqual(before.revisions);
  });
});
