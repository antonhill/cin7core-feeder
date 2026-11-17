import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { redactInternalFinancials } from "@/newquip/quote/margin";
import { emptyCommercialSettings, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { skuNeedsOf } from "@/newquip/pricing/estimator";
import { AUTO_ACTOR } from "@/newquip/pricing/auto-costing";
import { createQuote, loadQuote, saveDraft } from "../quote-store";
import { listPricingRevisions } from "../pricing-store";
import { saveCommercialSettings } from "../document-store";
import { isAutoOwned, READ_CHUNK, runAutoPricing, runAutoPricingTopUp, type AutoActor, type AutoEnv, type AutoPricingDeps } from "../auto-pricing-service";

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
const draftOn = () => { const d = readyDraft(); d.estimator.templateRevision = "grower-2026-11"; return d; };
async function newQuote(): Promise<string> { const { id } = await createQuote(db as never, ORG, "rep@nq"); await saveDraft(db as never, ORG, member, id, draftOn()); return id; }
const calls: string[][] = [];
const okRaw = (s: string) => ({ raw: { SKU: s, Status: "Active", Name: s, Suppliers: [{ SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-06-16" }] } });
type Reader = AutoPricingDeps["readRaw"];
const deps = (read?: Reader): AutoPricingDeps => ({
  readRaw: read ? async (skus, d) => { calls.push([...skus]); return read(skus, d); } : async (skus) => { calls.push([...skus]); return Object.fromEntries(skus.map((s) => [s, okRaw(s)])); },
  suppliers: async () => [{ id: "E1", name: "Test EUR Co", currency: "EUR", active: true }],
  now: () => NOW,
});
const REP: AutoActor = { orgId: ORG, userId: "u-rep", roles: new Set(["rep"]), demo: false };
const EST: AutoActor = { orgId: ORG, userId: "u-est", roles: new Set(["estimator"]), demo: false, canSeeCost: true };
const ON: AutoEnv = { NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "2026-10-01T00:00:00Z" };
const run = (id: string, d = deps()) => runAutoPricing(db as never, REP, id, d, ON);
const top = (id: string, actor: AutoActor = EST, d = deps()) => runAutoPricingTopUp(db as never, actor, id, d, ON);
const priceOf = async (id: string) => (await loadQuote(db as never, ORG, id))!;
const needOf = () => skuNeedsOf(evaluateDraft(draftOn(), { priceSource: testPriceSource(), withholdCost: true }).budget).map((n) => n.sku);
const unreadFor = (skus: string[]): Reader => async (list) => Object.fromEntries(list.map((s) => [s, skus.includes(s) ? { error: "deadline" } : okRaw(s)]));

beforeEach(async () => {
  db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; db.deliveryApplied = true; seedGoldenCatalogue(db as never, ORG); calls.length = 0;
  await saveCommercialSettings(db as never, ORG, SETTINGS({ markupBps: 2500 }), "mgr@nq", NOW);
});

describe("hand-off: every product is read, the reason is stored, the retry prices the rest", () => {
  it("a quotation needing more than one chunk is priced in ONE run (nothing is cut at 12)", async () => {
    const id = await newQuote();
    const need = needOf();
    expect(need.length).toBeGreaterThan(READ_CHUNK);
    expect((await run(id)).status).toBe("applied");
    expect(calls.flat().sort()).toEqual([...need].sort());
    expect(calls.length).toBeGreaterThan(1); // successive chunks
    const p = (await priceOf(id)).draft.estimator.pricing!;
    expect(Object.keys(p.skus).sort()).toEqual([...need].sort());
    expect(p.autoFlags).toBeUndefined();
  });

  it("an unread product is stored with its SPECIFIC reason; a Rep copy never carries it; the retry prices it and clears the reason", async () => {
    const id = await newQuote();
    const lastTwo = needOf().slice(-2);
    const o1 = await run(id, deps(unreadFor(lastTwo)));
    expect(o1).toMatchObject({ status: "applied", pendingCount: 2 });
    const q1 = await priceOf(id);
    const f = q1.draft.estimator.pricing!.autoFlags!;
    expect(Object.keys(f).sort()).toEqual([...lastTwo].sort());
    expect(f[lastTwo[0]]).toMatchObject({ code: "not_read", at: NOW });
    expect(f[lastTwo[0]]!.internal).toMatch(/will be retried/);
    expect(isAutoOwned(q1.draft.estimator.pricing!)).toBe(true);
    // a Rep never receives the pricing at all (so never the flags); the outcome's own wording is the neutral text
    const rep = redactInternalFinancials(q1 as never, false) as unknown as { draft: { estimator: { pricing?: unknown } } };
    expect(rep.draft.estimator.pricing).toBeUndefined();
    expect(JSON.stringify(rep)).not.toContain("will be retried");
    expect(JSON.stringify(o1.pending)).not.toMatch(/\d/); // no figure of any kind
    expect(o1.pending).toEqual(["Price pending: the supplier cost has not been read yet"]);
    // the retry (the hand-off) reads only the two missing products; existing entries are untouched
    const keep = (p: NonNullable<typeof q1.draft.estimator.pricing>) => JSON.stringify(Object.entries(p.skus).filter(([k]) => !lastTwo.includes(k)).sort());
    const before = keep(q1.draft.estimator.pricing!);
    calls.length = 0;
    expect(await run(id)).toMatchObject({ status: "applied", added: 2, pendingCount: 0 });
    expect(calls.flat().sort()).toEqual([...lastTwo].sort());
    const p2 = (await priceOf(id)).draft.estimator.pricing!;
    expect(p2.autoFlags).toBeUndefined();
    expect(keep(p2)).toBe(before);
  });

  it("when a retry still cannot price a product the stored reason is REPLACED by the new specific one (one revision), and an identical retry writes nothing", async () => {
    const id = await newQuote();
    const lastTwo = needOf().slice(-2);
    await run(id, deps(unreadFor(lastTwo)));
    const noSupplier: Reader = async (list) => Object.fromEntries(list.map((s) => [s, { raw: { SKU: s, Status: "Active", Name: s, Suppliers: [] } }]));
    expect(await run(id, deps(noSupplier))).toMatchObject({ status: "applied", added: 0, pendingCount: 2 });
    expect((await priceOf(id)).draft.estimator.pricing!.autoFlags![lastTwo[0]]!.code).toBe("no_cost");
    const n = (await listPricingRevisions(db as never, ORG, id)).length;
    expect((await run(id, deps(noSupplier))).status).toBe("no_prices"); // same reasons: nothing to record
    expect(await listPricingRevisions(db as never, ORG, id)).toHaveLength(n);
    expect(isAutoOwned((await priceOf(id)).draft.estimator.pricing!)).toBe(true);
  });

  it("the Estimator top-up adds ONLY the SKUs with no entry, keeps every stored entry byte for byte, and is refused to a Rep, a non-Estimator, a caller without cost and a demo actor", async () => {
    const id = await newQuote();
    const lastOne = needOf().slice(-1);
    await run(id, deps(unreadFor(lastOne)));
    (db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, unknown>).state = "ESTIMATOR_REVIEW";
    const keep = (p: NonNullable<Awaited<ReturnType<typeof priceOf>>["draft"]["estimator"]["pricing"]>) => JSON.stringify(Object.entries(p.skus).filter(([k]) => !lastOne.includes(k)).sort());
    const stored = keep((await priceOf(id)).draft.estimator.pricing!);
    expect((await run(id)).status).toBe("not_applicable"); // a Rep run does not touch a quotation in Estimator review
    expect((await top(id, { ...EST, roles: new Set(["manager"]) })).status).toBe("not_applicable");
    expect((await top(id, { ...EST, canSeeCost: false })).status).toBe("not_applicable");
    expect((await top(id, { ...EST, demo: true })).status).toBe("not_applicable");
    expect((await top(id, REP)).status).toBe("not_applicable");
    calls.length = 0;
    expect(await top(id)).toMatchObject({ status: "applied", added: 1 });
    expect(calls.flat()).toEqual(lastOne);
    const p = (await priceOf(id)).draft.estimator.pricing!;
    expect(keep(p)).toBe(stored);
    expect(p.skus[lastOne[0]]).toMatchObject({ costKind: "cin7_auto", by: AUTO_ACTOR });
    expect(p.autoFlags).toBeUndefined();
  });

  it("the Estimator top-up is refused once a person has changed the pricing (human edits end automatic pricing)", async () => {
    const id = await newQuote();
    await run(id);
    const rows = db.rows("newquip_pricing_revisions") as Array<Record<string, unknown>>;
    rows[rows.length - 1].changed_by_email = "estimator@nq";
    (db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, unknown>).state = "ESTIMATOR_REVIEW";
    expect((await top(id)).status).toBe("not_applicable");
  });
});
