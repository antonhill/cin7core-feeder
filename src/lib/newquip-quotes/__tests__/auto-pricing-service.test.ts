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
import { latestCommercialSettings, saveCommercialSettings } from "../document-store";
import { FEED_ACTOR, refreshFxFromFeed } from "../fx-feed";
import { autoPricingCutoff, isAutoOwned, READ_CHUNK, RUN_BUDGET_MS, runAutoPricing, type AutoActor, type AutoEnv, type AutoPricingDeps } from "../auto-pricing-service";
import { createEstimatorPriceSource } from "@/newquip/pricing/estimator";

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
  readRaw: async (skus, _deadline) => { void _deadline; calls.push([...skus]); return Object.fromEntries(skus.map((s) => [s, { raw: { SKU: s, Status: "Active", Name: s, Suppliers: [{ SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-06-16" }] } }])); },
  suppliers: async () => [{ id: "E1", name: "Test EUR Co", currency: "EUR", active: true }],
  now: () => NOW,
  ...over,
});
const REP: AutoActor = { orgId: ORG, userId: "u-rep", roles: new Set(["rep"]), demo: false };
const ON: AutoEnv = { NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "2026-10-01T00:00:00Z" }; // FakeDb quotes are created on 2026-10-15
const run = (id: string, d = deps(), actor: AutoActor = REP, env: AutoEnv = ON) => runAutoPricing(db as never, actor, id, d, env);
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
    while ((await run(id)).status === "applied") { /* every needed product is read in one run: the loop ends at once */ }
    const before = JSON.stringify((await priceOf(id)).draft);
    calls.length = 0;
    const o = await run(id);
    expect(o.status).toBe("nothing_to_add");
    expect(calls).toHaveLength(0);
    expect(JSON.stringify((await priceOf(id)).draft)).toBe(before);
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBeGreaterThan(0);
  });

  it("never prices a product Cin7 cannot cost: it is flagged (neutral for a Rep) and left unpriced", async () => {
    const id = await newQuote();
    const first = [...skuNeedsOf(evaluateDraft(draftOn(), { priceSource: testPriceSource(), withholdCost: true }).budget)][0].sku;
    const o = await run(id, deps({ readRaw: async (skus) => Object.fromEntries(skus.map((s) => [s, { raw: s === first ? null : { SKU: s, Status: "Active", Suppliers: [{ SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-06-16" }] } }])) }));
    expect(o.status).toBe("applied");
    expect(o.pendingCount).toBeGreaterThanOrEqual(1);
    expect(o.pending).toContain("No Cin7 cost for this product");
    expect(Object.keys((await priceOf(id)).draft.estimator.pricing!.skus)).toHaveLength(o.added);
  });

  it("a stale exchange rate gives NO price and writes nothing", async () => {
    await saveCommercialSettings(db as never, ORG, SETTINGS({ fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-01T00:00:00Z" } } }), "mgr@nq", NOW);
    const id = await newQuote();
    const o = await run(id);
    expect(o.status).toBe("no_prices");
    expect(o.pending).toContain("Price pending: commercial settings incomplete");
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

// A NEWLY CREATED quotation (not one that already carries cost evidence): the exchange rates stored in the commercial settings are older than the Manager's maximum age, exactly as on newquip-uat when a Rep creates a
// quotation the day after the last rate refresh. Foreign-currency products can only be priced from a FRESH rate; this proves the on-demand refresh restores pricing, and that when no refresh is possible the real reason is recorded.
describe("a NEW quotation when the stored exchange rates have gone stale (NQ-Q-0006)", () => {
  const STALE = () => SETTINGS({ fxMaxAgeDays: 1, fx: { EUR: { rateMicro: 18_615_387, source: "OXR", asOf: "2026-11-14T11:00:00Z", origin: "oxr" }, USD: { rateMicro: 16_942_404, source: "OXR", asOf: "2026-11-14T11:00:00Z", origin: "oxr" } } });
  const ts = Math.floor(Date.parse(NOW) / 1000) - 600;
  const provider = (): typeof fetch => (async () => ({ ok: true, status: 200, json: async () => ({ base: "USD", timestamp: ts, rates: { ZAR: 17.0, EUR: 0.92 } }) })) as unknown as typeof fetch;

  it("with the feed available the stale rate is refreshed first and the foreign-currency products ARE priced automatically (and a new settings version holds the fresh rate)", async () => {
    await saveCommercialSettings(db as never, ORG, STALE(), "mgr@nq", NOW);
    const id = await newQuote();
    const o = await run(id, deps({ refreshFx: (nowIso) => refreshFxFromFeed(db as never, ORG, FEED_ACTOR, { onlyIfStale: true, nowIso, env: { OPENEXCHANGERATES_APP_ID: "test" }, fetchFn: provider() }) }));
    expect(o.status).toBe("applied");
    expect(o.added).toBeGreaterThan(0);
    const priced = (await priceOf(id)).draft.estimator.pricing!;
    expect(Object.keys(priced.skus).length).toBe(o.added);
    expect(Object.values(priced.skus).some((e) => e?.currency === "EUR")).toBe(true); // a foreign-currency product was priced
    expect((await latestCommercialSettings(db as never, ORG, NOW))!.settings.fx.EUR.origin).toBe("oxr"); // fresh rate stored (append-only version)
  });
  it("with NO refresh possible the products stay unpriced, nothing is invented, and the recorded reason names the missing refresh (not just 'older than 1 day')", async () => {
    await saveCommercialSettings(db as never, ORG, STALE(), "mgr@nq", NOW);
    const id = await newQuote();
    const o = await run(id, deps({ refreshFx: async () => ({ ok: false, error: "The Open Exchange Rates feed is not configured for this deployment.", updated: [], keptManual: [], unchanged: [] }) }));
    const own = Object.values((await priceOf(id)).draft.estimator.pricing?.skus ?? {});
    expect(own.some((e) => e?.currency === "EUR" || e?.currency === "USD")).toBe(false); // domestic (ZAR) products price; NO foreign-currency product is priced from a stale rate
    const staleReasons = o.internal.filter((i) => i.code === "fx_stale");
    expect(staleReasons.length).toBeGreaterThan(0);
    for (const r of staleReasons) expect(r.text).toMatch(/exchange rate is older than 1 day.*automatic rate refresh did not happen: The Open Exchange Rates feed is not configured/);
    expect(o.pending.join(" ")).not.toMatch(/exchange|feed|rate/i); // the Rep-safe wording never carries the internal reason
  });
  it("a refresh that THROWS is also recorded (never swallowed) and never prices anything", async () => {
    await saveCommercialSettings(db as never, ORG, STALE(), "mgr@nq", NOW);
    const id = await newQuote();
    const o = await run(id, deps({ refreshFx: async () => { throw new Error("provider unreachable"); } }));
    expect(Object.values((await priceOf(id)).draft.estimator.pricing?.skus ?? {}).some((e) => e?.currency === "EUR")).toBe(false);
    expect(o.internal.find((i) => i.code === "fx_stale")!.text).toMatch(/provider unreachable/);
  });
});

describe("every entry is gated identically inside runAutoPricing (H1)", () => {
  beforeEach(async () => { await saveCommercialSettings(db as never, ORG, SETTINGS(), "mgr@nq", NOW); });
  it("flag off / missing or invalid cutoff = OFF: no read, no write", async () => {
    const id = await newQuote();
    for (const env of [{}, { NEWQUIP_AUTO_PRICING: "on" }, { NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "yesterday" }, { NEWQUIP_AUTO_PRICING: "true", NEWQUIP_AUTO_PRICING_FROM: "2026-10-01T00:00:00Z" }, { NEWQUIP_AUTO_PRICING_FROM: "2026-10-01T00:00:00Z" }]) {
      expect((await run(id, deps(), REP, env)).status).toBe("not_applicable");
      expect(autoPricingCutoff(env)).toBeNull();
    }
    expect(calls).toHaveLength(0);
    expect((await priceOf(id)).draft.estimator.pricing).toBeUndefined();
  });
  it("flag on with a valid cutoff runs for a real Rep", async () => {
    expect(autoPricingCutoff(ON)).toBe(Date.parse("2026-10-01T00:00:00Z"));
    expect((await run(await newQuote())).status).toBe("applied");
  });
  it("a demo identity and a non-Rep (Estimator / Manager only) are refused", async () => {
    const id = await newQuote();
    expect((await run(id, deps(), { ...REP, demo: true })).status).toBe("not_applicable");
    expect((await run(id, deps(), { ...REP, roles: new Set(["estimator"]) })).status).toBe("not_applicable");
    expect((await run(id, deps(), { ...REP, roles: new Set(["manager"]) })).status).toBe("not_applicable");
    expect(calls).toHaveLength(0);
  });
});

describe("existing quotes and human decisions are never repriced (H3)", () => {
  beforeEach(async () => { await saveCommercialSettings(db as never, ORG, SETTINGS(), "mgr@nq", NOW); });
  it("a quote created BEFORE the cutoff is excluded; one created on/after it is included", async () => {
    const id = await newQuote();
    expect((await run(id, deps(), REP, { ...ON, NEWQUIP_AUTO_PRICING_FROM: "2026-11-01T00:00:00Z" })).status).toBe("not_applicable");
    expect(calls).toHaveLength(0);
    expect((await run(id)).status).toBe("applied");
  });
  it("a human switch-off is respected: the quotation is never auto-priced again", async () => {
    const id = await newQuote();
    await run(id);
    const q = await priceOf(id);
    // a person switches pricing off (the revision is recorded by the human, the pricing is removed)
    const row = db.rows("newquip_quotes").find((r) => r.id === id) as unknown as { draft: typeof q.draft };
    const prior = row.draft.estimator.pricing; delete row.draft.estimator.pricing;
    db.rows("newquip_pricing_revisions").push({ id: "rev-off", org_id: ORG, quote_id: id, seq: 2, quote_revision: 1, kind: "DISABLED", rule_version: "newquip-supplier-v1", reason: "off", changes: [], changed_by: "est@nq", created_at: "2026-10-16T00:00:00Z", new_pricing_hash: "h", previous_pricing: prior });
    calls.length = 0;
    expect((await run(id)).status).toBe("not_applicable");
    expect(calls).toHaveLength(0);
    expect((await priceOf(id)).draft.estimator.pricing).toBeUndefined();
  });
  it("a quotation with any human pricing revision (even with no pricing left) is excluded", async () => {
    const id = await newQuote();
    db.rows("newquip_pricing_revisions").push({ id: "rev-x", org_id: ORG, quote_id: id, seq: 1, quote_revision: 1, kind: "DISABLED", rule_version: "legacy-poc-v1", reason: "off", changes: [], changed_by: "est@nq", created_at: "2026-10-16T00:00:00Z", new_pricing_hash: "h" });
    expect((await run(id)).status).toBe("not_applicable");
  });
});

describe("no stale write over a concurrent change (H2)", () => {
  beforeEach(async () => { await saveCommercialSettings(db as never, ORG, SETTINGS(), "mgr@nq", NOW); });
  it("an Estimator writing pricing between the Cin7 read and the write: nothing is written, outcome 'skipped'", async () => {
    const id = await newQuote();
    const o = await run(id, deps({ readRaw: async (skus) => {
      // the Estimator's pricing lands while the reads are in flight (a different draft hash and human-entered pricing)
      const row = db.rows("newquip_quotes").find((r) => r.id === id) as unknown as { draft: { estimator: { pricing?: unknown } }; draft_hash: string };
      row.draft.estimator.pricing = { enabled: true, ruleVersionId: "legacy-poc-v1", pricingDate: NOW, revision: 1, skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null };
      row.draft_hash = "changed-by-estimator";
      return Object.fromEntries(skus.map((s) => [s, { raw: { SKU: s, Status: "Active", Suppliers: [{ SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-06-16" }] } }]));
    } }));
    expect(o.status).toBe("skipped");
    expect((await priceOf(id)).draft.estimator.pricing).toMatchObject({ ruleVersionId: "legacy-poc-v1", skus: {} });
    expect(await listPricingRevisions(db as never, ORG, id)).toHaveLength(0);
  });
});

describe("one overall Cin7 budget per run (M2)", () => {
  beforeEach(async () => { await saveCommercialSettings(db as never, ORG, SETTINGS(), "mgr@nq", NOW); });
  it("reads EVERY needed product in successive chunks of READ_CHUNK, hands the adapter ONE overall deadline, and flags the unreached", async () => {
    const id = await newQuote();
    const need = skuNeedsOf(evaluateDraft(draftOn(), { priceSource: testPriceSource(), withholdCost: true }).budget).length;
    expect(need).toBeGreaterThan(READ_CHUNK);
    const sizes: number[] = []; const deadlines = new Set<number>(); const t0 = Date.now();
    const o = await run(id, deps({ readRaw: async (skus, d) => { sizes.push(skus.length); deadlines.add(d); return Object.fromEntries(skus.map((s) => [s, { error: "deadline" }])); } }));
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(need); // beyond the old cap of 12: all of them
    expect(Math.max(...sizes)).toBeLessThanOrEqual(READ_CHUNK);
    expect(deadlines.size).toBe(1); expect([...deadlines][0] - t0).toBeLessThanOrEqual(RUN_BUDGET_MS + 1000);
    expect(RUN_BUDGET_MS).toBeLessThanOrEqual(45_000);
    expect(o.status).toBe("no_prices");
    expect(o.pendingCount).toBe(need);
  });
  it("a slow supplier directory that uses up the budget leaves no time to read: nothing is read and everything is flagged", async () => {
    vi.useFakeTimers();
    try {
      const id = await newQuote();
      const p = run(id, deps({ suppliers: async () => { vi.setSystemTime(Date.now() + RUN_BUDGET_MS + 1); return []; } }));
      const o = await p;
      expect(calls).toHaveLength(0);
      expect(o.status).toBe("no_prices");
    } finally { vi.useRealTimers(); }
  });
});

describe("stored FX is frozen with the pricing (M3)", () => {
  it("the rate is judged fresh when written; a later evaluation (days later) still prices, because the pricing date and rate are fixed", async () => {
    await saveCommercialSettings(db as never, ORG, SETTINGS({ fxMaxAgeDays: 1 }), "mgr@nq", NOW);
    const id = await newQuote();
    await run(id);
    const p = (await priceOf(id)).draft.estimator.pricing!;
    expect(p.fxQuotes.EUR).toMatchObject({ rateMicro: 20_000_000, asOf: "2026-11-16T07:00:00Z" });
    vi.useFakeTimers(); vi.setSystemTime(new Date("2026-12-31T00:00:00Z"));
    try { const sku = Object.keys(p.skus)[0]; expect(createEstimatorPriceSource(p).priceFor(sku, "project").status).toBe("priced"); } finally { vi.useRealTimers(); }
  });

  it("a cutoff without a timezone is rejected (auto stays off): no server-local interpretation", () => {
    expect(autoPricingCutoff({ NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "2026-11-17T00:00:00" })).toBeNull();
    expect(autoPricingCutoff({ NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "2026-11-17T00:00:00Z" })).not.toBeNull();
    expect(autoPricingCutoff({ NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "2026-11-17T00:00:00+02:00" })).not.toBeNull();
  });
});
