import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { emptyCommercialSettings, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { skuNeedsOf } from "@/newquip/pricing/estimator";
import { AUTO_ACTOR } from "@/newquip/pricing/auto-costing";
import { createQuote, loadQuote, saveDraft } from "../quote-store";
import { listPricingRevisions } from "../pricing-store";
import { saveCommercialSettings } from "../document-store";
import { isAutoOwned, runAutoPricing, type AutoPricingDeps } from "../auto-pricing-service";

// ALL FIGURES ARE FICTITIOUS TEST NUMBERS. The Cin7 reads are faked (the real ones are GET-only); nothing here touches Cin7 or a database.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/projects/latest-cost-adapter", () => ({ listCin7Suppliers: vi.fn(), readRawProductsForSurvey: vi.fn() }));
vi.mock("../context", async () => {
  const { testPriceSource: src } = await import("@/newquip/grower/__tests__/test-snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(), withholdCost }) };
});

const ORG = "org-nq";
const NOW = "2026-11-16T09:00:00Z";
let db: FakeDb;
const member = rolesFor("member");
const SETTINGS = (over: Partial<CommercialSettings> = {}): CommercialSettings => ({
  ...emptyCommercialSettings(),
  freight: { factorMicro: 1_100_000, addOnCents: 0, source: "test freight policy" },
  fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-16T07:00:00Z" } },
  ...over,
});
const draftOn = (rev = true) => { const d = readyDraft(); if (rev) d.estimator.templateRevision = "grower-2026-11"; return d; };
async function newQuote(d = draftOn()): Promise<string> { const { id } = await createQuote(db as never, ORG, "rep@nq"); await saveDraft(db as never, ORG, member, id, d); return id; }
const calls: string[][] = [];
const deps = (over: Partial<AutoPricingDeps> = {}): AutoPricingDeps => ({
  readRaw: async (skus) => { calls.push([...skus]); return Object.fromEntries(skus.map((s) => [s, { raw: { SKU: s, Status: "Active", Name: s, Suppliers: [{ SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-06-16" }] } }])); },
  suppliers: async () => [{ id: "E1", name: "Test EUR Co", currency: "EUR", active: true }],
  now: () => NOW,
  ...over,
});
const run = (id: string, d = deps()) => runAutoPricing(db as never, { orgId: ORG, userId: "u-rep" }, id, d);
const priceOf = async (id: string) => (await loadQuote(db as never, ORG, id))!;

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; db.deliveryApplied = true; seedGoldenCatalogue(db as never, ORG); calls.length = 0; });

describe("runAutoPricing: when it does NOT run", () => {
  it("settings incomplete: no Cin7 read, no write, neutral wording only", async () => {
    const id = await newQuote();
    const o = await run(id);
    expect(o).toMatchObject({ status: "settings_incomplete", added: 0, pending: ["Price pending: commercial settings incomplete"] });
    expect(calls).toHaveLength(0);
    expect((await priceOf(id)).draft.estimator.pricing).toBeUndefined();
    expect(await listPricingRevisions(db as never, ORG, id)).toHaveLength(0);
  });
  it("a freight policy that is not set blocks everything even when an exchange rate exists", async () => {
    await saveCommercialSettings(db as never, ORG, SETTINGS({ freight: null }), "mgr@nq", NOW);
    const id = await newQuote();
    expect((await run(id)).status).toBe("settings_incomplete");
    expect(calls).toHaveLength(0);
  });
  it("legacy template revision, POC presentation, day-to-day and non-Rep-draft quotations are left alone", async () => {
    await saveCommercialSettings(db as never, ORG, SETTINGS(), "mgr@nq", NOW);
    const legacy = await newQuote(draftOn(false));
    delete (db.rows("newquip_quotes").find((r) => r.id === legacy) as unknown as { draft: { estimator: { templateRevision?: string } } }).draft.estimator.templateRevision; // an original-template quotation
    expect((await run(legacy)).status).toBe("not_applicable");
    const poc = await newQuote();
    (db.rows("newquip_quotes").find((r) => r.id === poc) as unknown as { draft: { estimator: { pocPresentation?: boolean } } }).draft.estimator.pocPresentation = true; // the server-owned POC flag
    expect((await run(poc)).status).toBe("not_applicable");
    const day = await newQuote();
    (db.rows("newquip_quotes").find((r) => r.id === day) as unknown as { draft: { quoteType: string } }).draft.quoteType = "day_to_day";
    expect((await run(day)).status).toBe("not_applicable");
    const review = await newQuote();
    (db.rows("newquip_quotes").find((r) => r.id === review) as Record<string, unknown>).state = "ESTIMATOR_REVIEW";
    expect((await run(review)).status).toBe("not_applicable");
    expect(calls).toHaveLength(0);
  });
});

describe("runAutoPricing: pricing a Rep draft", () => {
  beforeEach(async () => { await saveCommercialSettings(db as never, ORG, SETTINGS({ markupBps: 2500 }), "mgr@nq", NOW); });

  it("records ONE revision through the existing path, marks every cost automatic + unverified, and the Rep-visible evaluation carries prices but no cost", async () => {
    const id = await newQuote();
    const o = await run(id);
    expect(o.status).toBe("applied");
    expect(o.added).toBeGreaterThan(0);
    const q = await priceOf(id);
    const p = q.draft.estimator.pricing!;
    expect(p).toMatchObject({ enabled: true, ruleVersionId: "newquip-supplier-v1", revision: 1 });
    expect(Object.values(p.skus).every((s) => s!.costKind === "cin7_auto" && s!.by === AUTO_ACTOR && !s!.review)).toBe(true);
    expect(p.projectMarkup).toMatchObject({ markupBps: 2500, by: AUTO_ACTOR });
    expect(isAutoOwned(p)).toBe(true);
    const revs = await listPricingRevisions(db as never, ORG, id);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({ kind: "ENABLED", changedBy: AUTO_ACTOR });
    // same numbers for the Rep (cost withheld) and the Estimator (cost visible): the SAME engine
    const rep = evaluateDraft(q.draft, { priceSource: testPriceSource(), withholdCost: true });
    const est = evaluateDraft(q.draft, { priceSource: testPriceSource(), withholdCost: false });
    expect(rep.budget!.totals.subtotalExTax).toBe(est.budget!.totals.subtotalExTax);
    expect(rep.budget!.lines.every((l) => l.estimatedCost === null && l.estimatedGP === null && l.marginPct === null)).toBe(true); // prices, never costs
    expect(rep.budget!.totals.estimatedCost).toBe(0);
  });

  it("is IDEMPOTENT: a second run reads nothing and changes nothing", async () => {
    const id = await newQuote();
    await run(id);
    const before = JSON.stringify((await priceOf(id)).draft);
    calls.length = 0;
    const o = await run(id);
    expect(o.status).toBe("nothing_to_add");
    expect(calls).toHaveLength(0);
    expect(JSON.stringify((await priceOf(id)).draft)).toBe(before);
    expect(await listPricingRevisions(db as never, ORG, id)).toHaveLength(1);
  });

  it("never prices a product Cin7 cannot cost: it is flagged (neutral for a Rep) and left unpriced", async () => {
    const id = await newQuote();
    const first = [...skuNeedsOf(evaluateDraft(draftOn(), { priceSource: testPriceSource(), withholdCost: true }).budget)][0].sku;
    const o = await run(id, deps({ readRaw: async (skus) => Object.fromEntries(skus.map((s) => [s, { raw: s === first ? null : { SKU: s, Status: "Active", Suppliers: [{ SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-06-16" }] } }])) }));
    expect(o.status).toBe("applied");
    expect(o.pendingCount).toBe(1);
    expect(o.pending).toEqual(["No Cin7 cost for this product"]);
    expect(Object.keys((await priceOf(id)).draft.estimator.pricing!.skus)).toHaveLength(o.added);
  });

  it("a stale exchange rate gives NO price and writes nothing", async () => {
    await saveCommercialSettings(db as never, ORG, SETTINGS({ fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-01T00:00:00Z" } } }), "mgr@nq", NOW);
    const id = await newQuote();
    const o = await run(id);
    expect(o.status).toBe("no_prices");
    expect(o.pending).toEqual(["Price pending: commercial settings incomplete"]);
    expect((await priceOf(id)).draft.estimator.pricing).toBeUndefined();
  });

  it("never overwrites an Estimator's cost and stops owning a quotation once a person has changed it", async () => {
    const id = await newQuote();
    await run(id);
    const q = await priceOf(id);
    const p = structuredClone(q.draft.estimator.pricing!);
    const sku = Object.keys(p.skus)[0];
    p.skus[sku] = { ...p.skus[sku]!, by: "est@nq", costKind: "supplier_quotation", nativeUnitCostE7: 12_345_678, source: "Estimator quote Q1" };
    expect(isAutoOwned(p)).toBe(false);
    (db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, unknown> & { draft: typeof q.draft }).draft.estimator.pricing = p;
    const o = await run(id);
    expect(o.status).toBe("not_applicable");
    expect((await priceOf(id)).draft.estimator.pricing!.skus[sku]).toMatchObject({ nativeUnitCostE7: 12_345_678, costKind: "supplier_quotation" });
  });

  it("when the commercial settings change after a quotation was priced it adds nothing (awaiting the Estimator)", async () => {
    const id = await newQuote();
    await run(id);
    const d = draftOn(); d.config = { ...d.config, estimatorQuantities: { ...d.config.estimatorQuantities } };
    await saveCommercialSettings(db as never, ORG, SETTINGS({ markupBps: 3000 }), "mgr@nq", NOW);
    const o = await run(id);
    expect(o.status).toBe("settings_changed");
    expect(o.pending[0]).toMatch(/awaiting the Estimator/);
  });
});
