// FRESH REP BUDGET ACCEPTANCE (NewQuip P0, 26 Nov 2026): a Rep who builds a fully configured quotation from scratch gets a COMPLETE Budget with NO Estimator involvement, every selected line priced
// (provisionally where its basis is provisional), zero unpriced lines, and a Budget document whose totals match the engine to the cent. FICTITIOUS cost figures; the Cin7 reads are faked and PACED exactly like
// the real adapter (only about 35 products are read per 40-second run: the root cause of "INCOMPLETE PRICING - 11 items not yet priced" on NQ-Q-0015).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { emptyCommercialSettings, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { AUTO_ACTOR } from "@/newquip/pricing/auto-costing";
import { DOOR_SIZES } from "@/newquip/grower/door-sizes";
import { UAT_PROVISIONAL_ENV, uatProvisionalRatesFromEnv } from "@/newquip/grower/uat-provisional-basis";
import { createQuote, loadQuote, saveDraft } from "../quote-store";
import { listPricingRevisions } from "../pricing-store";
import { saveCommercialSettings } from "../document-store";
import { completeAutoPricing, runAutoPricing, type AutoActor, type AutoEnv, type AutoPricingDeps } from "../auto-pricing-service";
import { budgetSkuNeeds } from "../sku-needs";
import { landedZarSkuSet } from "@/newquip/pricing/cost-source-classes";
import { buildBudgetDocumentModel, presentsPartialAsTotal } from "../budget-document";
import { unreadNeeds } from "../budget-quotation";
import type { QuoteDraft } from "@/newquip/grower/draft";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/projects/latest-cost-adapter", () => ({ listCin7Suppliers: vi.fn(), readRawProductsForSurvey: vi.fn() }));
vi.mock("../context", async () => {
  const { testPriceSource: src } = await import("@/newquip/grower/__tests__/test-snapshot");
  return { evaluationContext: (withholdCost: boolean) => ({ priceSource: src(), withholdCost }) };
});

const ORG = "org-nq", NOW = "2026-11-26T04:30:00Z";
const PER_RUN = 30; // products one run can read before its time budget ends (the real run: about 35)
let db: FakeDb;
const member = rolesFor("member");
const SETTINGS: CommercialSettings = { ...emptyCommercialSettings(), markupBps: 2000, freight: { factorMicro: 1_150_000, addOnCents: 0, source: "test freight policy" }, fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-26T03:00:00Z" } } };
const DOOR_ENV = { [UAT_PROVISIONAL_ENV]: JSON.stringify({ [`pvc_door|${DOOR_SIZES["2.1x1.2"].specification}`]: { amount: 8000, asOf: "2026-11-24" }, [`pvc_door|${DOOR_SIZES["2.1x1.0"].specification}`]: { amount: 7500, asOf: "2026-11-24" } }) };
const rates = uatProvisionalRatesFromEnv(DOOR_ENV);

// The configuration Anton entered as an ordinary Rep on NQ-Q-0015 (12 rooms, 49.5 x 14.43 m, 600 pigs, 20 pens, every standard and supported additional item), with a door size chosen.
function freshRepDraft(over: { doorSize?: string; cooling?: number; controller?: boolean; silo?: boolean; windows?: number; fans?: number; plugs?: number } = {}): QuoteDraft {
  const d = readyDraft();
  d.estimator.templateRevision = "grower-2026-11";
  d.estimator.confirmedPackages = []; d.estimator.confirmedMappings = {}; d.estimator.priceResolutions = {};
  d.estimator.charges = { delivery: 100000, installation: 55000, commissioning: 6000, concrete_slat_delivery: 4000 };
  d.estimator.unitPrices = { flex_auger: 96442 };
  d.config = { ...d.config, rooms: 12, widthM: 14.43, lengthM: 49.5, totalPens: 20, hospitalPens: 2, pigsPerRoom: 600, feederVariant: "STANDARD", penningPigSize: "SMALL", penningRunningMetresPerRoom: 20, slattedFloorAreaM2: 120,
    doorSize: (over.doorSize ?? "2.1x1.2") as never, coolingSystemLengthM: over.cooling ?? 20,
    optionalEquipment: { cone_fans: true, controller: over.controller ?? true, manure_plug: true, pad_cooling: true, control_panel: true, silo_weighing: over.silo ?? true, emergency_windows: true },
    estimatorQuantities: { feeder: 18, pvc_door: 2, bulk_tank: 1, cone_fans: over.fans ?? 4, controller: 2, flex_auger: 1, cup_drinker: 54, manure_plug: over.plugs ?? 2, pad_cooling: 3, concrete_slat: 1320, control_panel: 2, silo_weighing: 2, emergency_windows: over.windows ?? 2 },
    quantityOverrides: { led_light: 38, feed_saver_mat: 18 }, quantityOverrideReasons: { led_light: "Test", feed_saver_mat: "Test" } } as never;
  return d;
}
const calls: string[][] = [];
let readThisRun = 0;
const deps = (): AutoPricingDeps => ({
  readRaw: async (skus) => Object.fromEntries(skus.map((s) => {
    calls.push([s]);
    if (readThisRun >= PER_RUN) return [s, { error: "deadline" }]; // the paced real adapter runs out of time here
    readThisRun += 1;
    // the Sage-landed ZAR items (cost-source-classes) are bought in rand; everything else here is a euro supplier
    const zar = landedZarSkuSet().has(s);
    return [s, { raw: { SKU: s, Status: "Active", Name: s, Suppliers: [zar ? { SupplierID: "Z1", SupplierName: "Test ZAR Co", Cost: 10, Currency: "ZAR", LastSupplied: "2026-11-25" } : { SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-11-25" }] } }];
  })),
  suppliers: async () => { readThisRun = 0; return [{ id: "E1", name: "Test EUR Co", currency: "EUR", active: true }, { id: "Z1", name: "Test ZAR Co", currency: "ZAR", active: true }]; }, // one supplier listing per run = the start of a run
  now: () => NOW,
});
const REP: AutoActor = { orgId: ORG, userId: "u-rep", roles: new Set(["rep"]), demo: false };
const ON: AutoEnv = { NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "2026-10-01T00:00:00Z" };
async function newQuote(d: QuoteDraft): Promise<string> { const { id } = await createQuote(db as never, ORG, "rep@nq"); await saveDraft(db as never, ORG, member, id, d); return id; }
/** The Rep's Budget evaluation, exactly as the Budget quotation builds it (selling prices only, provisional where provisional). */
const budgetOf = async (id: string) => { const q = (await loadQuote(db as never, ORG, id))!; return { q, b: evaluateDraft(q.draft, { priceSource: testPriceSource(), withholdCost: true, provisionalPackages: true, budgetAsOf: "2026-11-26", uatProvisionalRates: rates }).budget! }; };
const cents = (n: number) => Math.round(n * 100);

beforeEach(async () => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; db.deliveryApplied = true; seedGoldenCatalogue(db as never, ORG); calls.length = 0; readThisRun = 0; await saveCommercialSettings(db as never, ORG, SETTINGS, "mgr@nq", NOW); });

describe("a fresh Rep quotation, before any Estimator action", () => {
  it("THE DEFECT: one paced run (what a save did) leaves selected equipment unpriced, so the Budget said 'not yet priced'", async () => {
    const id = await newQuote(freshRepDraft());
    await runAutoPricing(db as never, REP, id, deps(), ON);
    const { b } = await budgetOf(id);
    expect(b.lines.filter((l) => l.status !== "not_selected" && l.status !== "priced").length).toBeGreaterThan(0);
  });

  it("completeAutoPricing prices EVERY selected line: zero unpriced, provisional lines included in the total, no Estimator involved", async () => {
    const id = await newQuote(freshRepDraft());
    const o = await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: deps(), env: ON });
        expect(o.runs).toBeGreaterThan(1);
    const { q, b } = await budgetOf(id);
    const selected = b.lines.filter((l) => l.status !== "not_selected");
    expect(selected.length).toBeGreaterThanOrEqual(14);
    expect(selected.filter((l) => l.status !== "priced").map((l) => `${l.itemKey}:${l.status}`)).toEqual([]);
    expect(b.state).toBe("complete"); expect(b.blockers).toEqual([]);
    // the whole dependency set was requested from Cin7 (every SKU the Budget looks up, none skipped)
    const requested = new Set(calls.flat());
    expect(budgetSkuNeeds(q.draft).map((n) => n.sku).filter((s) => !requested.has(s) && !(q.draft.estimator.pricing?.skus ?? {})[s])).toEqual([]);
    // the Estimator has not acted: still a Rep draft, only automatic revisions, nothing confirmed
    expect(q.state).toBe("REP_DRAFT");
    expect((await listPricingRevisions(db as never, ORG, id)).every((r) => r.changedBy === AUTO_ACTOR)).toBe(true);
    expect(q.draft.estimator.confirmedPackages).toEqual([]); expect(q.draft.estimator.confirmedMappings).toEqual({});
    // provisional lines are in the total, and marked
    const prov = selected.filter((l) => l.provisional);
    expect(prov.length).toBeGreaterThan(0);
  });

  it("the Budget document is complete and its totals equal an independent sum of the lines, to the cent (VAT 15%)", async () => {
    const id = await newQuote(freshRepDraft());
    await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: deps(), env: ON });
    const { q, b } = await budgetOf(id);
    const model = buildBudgetDocumentModel({ budget: b, quoteRef: "NQ-Q-FRESH", revision: 1, draftHash: q.draft_hash, preparedOn: "2026-11-26", siteName: "Fresh", customerName: "Spark", contact: null, profile: {} as never, config: q.draft.config, testOnly: true });
    expect(model.complete).toBe(true); expect(model.unpriced.count).toBe(0); expect(presentsPartialAsTotal(model)).toBe(false);
    const lines = b.lines.filter((l) => l.status === "priced");
    // a package is the sum of its components' unit price x component quantity; a single line is unit price x quantity
    const independent = lines.reduce((a, l) => a + (l.pricedBy === "price_source" && l.components ? l.components.reduce((x, c) => x + cents(c.unitPrice! * c.quantity!), 0) : cents(l.unitPrice! * l.quantity!)), 0) + cents(100000) + cents(55000 + 6000) + cents(4000);
    expect(cents(b.totals.subtotalExTax)).toBe(independent);
    expect(model.equipment.every((e) => e.status === "priced" || e.status === "provisional")).toBe(true);
    expect(model.equipment.map((e) => e.label).length).toBe(b.lines.filter((l) => l.status !== "not_selected").length); // no equipment omitted
    expect(cents(b.totals.taxTotal)).toBe(Math.round(independent * 0.15));
    expect(model.testOnly).toBe(true);
  });

  it("variants: both door sizes, cooling lengths, every control-panel configuration, window / fan / plug quantities all come out complete", async () => {
    const variants: Array<Parameters<typeof freshRepDraft>[0]> = [
      { doorSize: "2.1x1.0" }, { doorSize: "2.1x1.2" }, { cooling: 3 }, { cooling: 20 }, { cooling: 20.1 }, { cooling: 60 },
      { controller: true, silo: false }, { controller: false, silo: true }, { controller: true, silo: true }, { windows: 1 }, { windows: 6 }, { fans: 1 }, { fans: 12 }, { plugs: 1 }, { plugs: 10 },
    ];
    for (const v of variants) {
      db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; db.deliveryApplied = true; seedGoldenCatalogue(db as never, ORG);
      await saveCommercialSettings(db as never, ORG, SETTINGS, "mgr@nq", NOW);
      const id = await newQuote(freshRepDraft(v));
      await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: deps(), env: ON });
      const { b } = await budgetOf(id);
      expect(b.lines.filter((l) => l.status !== "not_selected" && l.status !== "priced").map((l) => l.itemKey), JSON.stringify(v)).toEqual([]);
      expect(b.state, JSON.stringify(v)).toBe("complete");
    }
  });

  it("an input that is genuinely missing is reported, never zeroed: a door with no size stays unpriced and says so", async () => {
    const d = freshRepDraft(); (d.config as unknown as Record<string, unknown>).doorSize = undefined;
    const id = await newQuote(d);
    await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: deps(), env: ON });
    const door = (await budgetOf(id)).b.lines.find((l) => l.itemKey === "pvc_door")!;
    expect(door.status).not.toBe("priced"); expect(door.reason).toMatch(/door size/i);
  });

  it("a product Cin7 genuinely has no supplier cost for does not loop forever or get a made-up price: everything else completes and the gap is named", async () => {
    const id = await newQuote(freshRepDraft());
    const base = deps();
    const noCost: AutoPricingDeps = { ...base, readRaw: async (skus, d) => { const r = await base.readRaw(skus, d); if ("NQ3369" in r) r["NQ3369"] = { raw: { SKU: "NQ3369", Status: "Active", Name: "x", Suppliers: [] } }; return r; } };
    const o = await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: noCost, env: ON });
    expect(o.runs).toBeLessThan(8);
    const { b } = await budgetOf(id);
    const unpriced = b.lines.filter((l) => l.status !== "not_selected" && l.status !== "priced");
    expect(unpriced.map((l) => l.itemKey)).toEqual(["pad_cooling"]); // only the package that contains the unpriceable acetone; nothing was zeroed or invented
    expect(b.state).not.toBe("complete");
  });

});

// THE LOOP CAN NEVER MAKE A PARTIALLY PRICED QUOTATION LOOK COMPLETE: timeout, no-progress and retry, with every earlier read preserved and nothing duplicated or re-priced.
describe("completion loop safety: timeout, no progress, retry", () => {
  const model = (q: Awaited<ReturnType<typeof budgetOf>>["q"], b: Awaited<ReturnType<typeof budgetOf>>["b"]) => buildBudgetDocumentModel({ budget: b, quoteRef: "NQ-Q-SAFE", revision: 1, draftHash: q.draft_hash, preparedOn: "2026-11-26", siteName: "S", customerName: "C", contact: null, profile: {} as never, config: q.draft.config, testOnly: true, retrievalPending: unreadNeeds(q.draft) });

  it("TIMEOUT on the very first run: nothing is priced, the outcome says products are unread, and the document is never complete", async () => {
    const id = await newQuote(freshRepDraft());
    const dead: AutoPricingDeps = { ...deps(), readRaw: async (skus) => Object.fromEntries(skus.map((s) => [s, { error: "deadline" }])) };
    const o = await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: dead, env: ON });
    expect(o.internal.some((i) => i.code === "not_read")).toBe(true);
    const { q, b } = await budgetOf(id);
    expect(b.state).not.toBe("complete");
    expect(model(q, b).complete).toBe(false);
  });

  it("NO PROGRESS (every read errors): the loop stops after the stall limit, still reports unread, and never completes", async () => {
    const id = await newQuote(freshRepDraft());
    let n = 0;
    const flaky: AutoPricingDeps = { ...deps(), readRaw: async (skus) => { n += skus.length; return Object.fromEntries(skus.map((s) => [s, { error: "http_503" }])); } };
    const o = await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: flaky, env: ON });
    expect(o.runs).toBeLessThanOrEqual(3); expect(n).toBeGreaterThan(0);
    expect(o.internal.some((i) => i.code === "not_read")).toBe(true);
    const { q, b } = await budgetOf(id);
    expect(model(q, b).complete).toBe(false);
  });

  it("PARTIAL then RETRY: successful reads are preserved byte-for-byte (no duplicate or re-priced cost), the final total equals a single full read to the cent, and the partial document was never complete", async () => {
    // reference: one quotation read completely in one go
    const refId = await newQuote(freshRepDraft());
    readThisRun = -1_000_000; // unlimited pace for the reference
    await completeAutoPricing(db as never, REP, refId, { budgetMs: 300_000, deps: deps(), env: ON });
    const ref = await budgetOf(refId);
    // the retry quotation: ONE paced run, then check, then the retry
    readThisRun = 0;
    const id = await newQuote(freshRepDraft());
    await runAutoPricing(db as never, REP, id, deps(), ON);
    const part = await budgetOf(id);
    expect(model(part.q, part.b).complete).toBe(false);
    expect(unreadNeeds(part.q.draft)).toBeGreaterThan(0);
    const before = structuredClone(part.q.draft.estimator.pricing!.skus);
    await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: deps(), env: ON });
    const done = await budgetOf(id);
    const after = done.q.draft.estimator.pricing!.skus;
    for (const [sku, e] of Object.entries(before)) expect(after[sku], sku).toEqual(e); // preserved exactly (same cost, same timestamp)
    expect(Object.keys(after).length).toBe(Object.keys(ref.q.draft.estimator.pricing!.skus).length); // exactly the same set of SKUs as one full read: nothing duplicated, nothing missing
    expect(unreadNeeds(done.q.draft)).toBe(0);
    expect(cents(done.b.totals.subtotalExTax)).toBe(cents(ref.b.totals.subtotalExTax));
    expect(model(done.q, done.b).complete).toBe(true);
  });

  it("INVARIANT: a document with unread supplier products is never complete and carries no total, even if every visible line looks priced", async () => {
    const id = await newQuote(freshRepDraft());
    readThisRun = -1_000_000;
    await completeAutoPricing(db as never, REP, id, { budgetMs: 300_000, deps: deps(), env: ON });
    const { q, b } = await budgetOf(id);
    expect(model(q, b).complete).toBe(true);
    const forced = buildBudgetDocumentModel({ budget: b, quoteRef: "X", revision: 1, draftHash: q.draft_hash, preparedOn: "2026-11-26", siteName: "S", customerName: "C", contact: null, profile: {} as never, config: q.draft.config, testOnly: true, retrievalPending: 3 });
    expect(forced.complete).toBe(false); expect(forced.totals.totalIncVat).toBeNull(); expect(forced.retrievalPending).toBe(3);
    expect(forced.unpriced.items.join(" ")).toMatch(/retrieval unfinished/i);
  });
});
