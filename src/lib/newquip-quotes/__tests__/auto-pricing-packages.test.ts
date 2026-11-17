import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { bulkConfirmablePackageKeys, manualSelectionSkusFor, packageFor, TEMPLATE_REVISION_CURRENT } from "@/newquip/grower/commercial";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { emptyCommercialSettings, type CommercialSettings } from "@/newquip/pricing/commercial-settings";
import { skuNeedsOf } from "@/newquip/pricing/estimator";
import { createQuote, loadQuote, saveDraft } from "../quote-store";
import { saveCommercialSettings } from "../document-store";
import { runAutoPricing, runAutoPricingTopUp, type AutoActor, type AutoEnv, type AutoPricingDeps } from "../auto-pricing-service";

// PACKAGE HANDLING (LED light, cup drinker, PVC door) with automatic pricing. ALL FIGURES ARE FICTITIOUS TEST NUMBERS; the Cin7 reads are faked (the real ones are GET-only).
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
const SETTINGS: CommercialSettings = { ...emptyCommercialSettings(), markupBps: 2500, freight: { factorMicro: 1_100_000, addOnCents: 0, source: "test freight policy" }, fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-16T07:00:00Z" } } };
const okRaw = (s: string) => ({ raw: { SKU: s, Status: "Active", Name: s, Suppliers: [{ SupplierID: "E1", SupplierName: "Test EUR Co", Cost: 10, Currency: "EUR", LastSupplied: "2026-06-16" }] } });
const calls: string[][] = [];
const deps = (unread: string[] = []): AutoPricingDeps => ({
  readRaw: async (skus) => { calls.push([...skus]); return Object.fromEntries(skus.map((s) => [s, unread.includes(s) ? { error: "deadline" } : okRaw(s)])); },
  suppliers: async () => [{ id: "E1", name: "Test EUR Co", currency: "EUR", active: true }],
  now: () => NOW,
});
const REP: AutoActor = { orgId: ORG, userId: "u-rep", roles: new Set(["rep"]), demo: false };
const EST: AutoActor = { orgId: ORG, userId: "u-est", roles: new Set(["estimator"]), demo: false, canSeeCost: true };
const ON: AutoEnv = { NEWQUIP_AUTO_PRICING: "on", NEWQUIP_AUTO_PRICING_FROM: "2026-10-01T00:00:00Z" };
const load = async (id: string) => (await loadQuote(db as never, ORG, id))!;
/** The Estimator's own draft save (a package confirmation or a product choice): the stored pricing is server-owned and kept, exactly as the action does it. */
async function estimatorSave(id: string, mut: (d: QuoteDraft) => void): Promise<void> {
  const d = structuredClone((await load(id)).draft); mut(d);
  await saveDraft(db as never, ORG, member, id, d, null, { keepStoredPricing: true });
}
const lineOf = (d: QuoteDraft, key: string) => evaluateDraft(d, { priceSource: testPriceSource(), withholdCost: false }).budget!.lines.find((l) => l.itemKey === key);

beforeEach(async () => {
  db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; db.deliveryApplied = true; seedGoldenCatalogue(db as never, ORG); calls.length = 0;
  await saveCommercialSettings(db as never, ORG, SETTINGS, "mgr@nq", NOW);
});

describe("the confirmed package definitions (verified in code, nothing invented)", () => {
  it("LED light: HNQ7046 x1 + HNQ7093 x3 + HNQ7088 x1 per light", () => {
    const led = packageFor("led_light", TEMPLATE_REVISION_CURRENT)!;
    expect(led.components.map((c) => [c.sku, c.qtyPerUnit])).toEqual([["HNQ7046", 1], ["HNQ7093", 3], ["HNQ7088", 1]]);
  });
  it("cup drinker: the seven-component build-up, with NB3542-03 shown as the ALTERNATIVE, and NEVER bulk-confirmed", () => {
    const cup = packageFor("cup_drinker", TEMPLATE_REVISION_CURRENT)!;
    expect(cup.components.map((c) => [c.sku, c.qtyPerUnit])).toEqual([["QCA00003", 1], ["NQ1380", 1], ["NQ2784", 1], ["NQ2886", 1], ["NQ1386", 5], ["NYNUT", 5], ["NQ1017", 5]]);
    expect(cup.alternativeIdentity).toMatchObject({ sku: "NB3542-03" });
    expect(bulkConfirmablePackageKeys(["cup_drinker", "led_light"], TEMPLATE_REVISION_CURRENT)).not.toContain("cup_drinker");
  });
  it("PVC door: the Estimator chooses among NQ3444, NQ2161 and NQ2281 only (no invented specification)", () => {
    expect(manualSelectionSkusFor("pvc_door", TEMPLATE_REVISION_CURRENT)).toEqual(["NQ3444", "NQ2161", "NQ2281"]);
  });
});

describe("the Estimator's confirmation keeps the automatic costs, and the top-up prices the newly chosen SKU", () => {
  const unconfirmed = (): QuoteDraft => {
    const d = readyDraft(); d.estimator.templateRevision = "grower-2026-11";
    d.estimator.confirmedPackages = d.estimator.confirmedPackages.filter((k) => k !== "cup_drinker" && k !== "led_light");
    delete d.estimator.confirmedMappings.pvc_door; // the door is the Estimator's choice
    return d;
  };
  async function priced(): Promise<string> {
    const { id } = await createQuote(db as never, ORG, "rep@nq");
    await saveDraft(db as never, ORG, member, id, unconfirmed());
    expect((await runAutoPricing(db as never, REP, id, deps(["QCA00003"]), ON)).status).toBe("applied");
    return id;
  }

  it("explicitly confirming the cup drinker and choosing a door changes NO stored automatic entry; the top-up adds only the SKU that had none (QCA00003, then the chosen door)", async () => {
    const id = await priced();
    const q0 = await load(id);
    const p0 = q0.draft.estimator.pricing!;
    expect(p0.autoFlags!.QCA00003).toMatchObject({ code: "not_read" });
    const before = JSON.stringify(Object.entries(p0.skus).sort());
    // the cup drinker needs the Estimator's EXPLICIT confirmation: nothing priced it, and the saved confirmation does not touch the stored costs
    expect(lineOf(q0.draft, "cup_drinker")?.status).not.toBe("priced");
    await estimatorSave(id, (d) => { d.estimator.confirmedPackages.push("cup_drinker"); d.estimator.confirmedMappings.pvc_door = "NQ3444"; });
    const afterSave = (await load(id)).draft.estimator.pricing!;
    expect(JSON.stringify(Object.entries(afterSave.skus).sort())).toBe(before);
    expect(afterSave.autoFlags).toEqual(p0.autoFlags);
    // the top-up: ONLY the SKUs with no entry are read
    (db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, unknown>).state = "ESTIMATOR_REVIEW";
    calls.length = 0;
    const o = await runAutoPricingTopUp(db as never, EST, id, deps(), ON);
    expect(o.status).toBe("applied");
    expect(calls.flat().sort()).toEqual(["NQ3444", "QCA00003"]);
    const q1 = await load(id);
    const p1 = q1.draft.estimator.pricing!;
    expect(JSON.stringify(Object.entries(p1.skus).filter(([k]) => k in p0.skus).sort())).toBe(before); // every earlier entry byte for byte
    expect(p1.autoFlags).toBeUndefined();
    expect(p1.skus.NQ3444).toMatchObject({ costKind: "cin7_auto" });
    // the cup drinker now prices from its seven automatic component costs; the door from the chosen SKU
    expect(lineOf(q1.draft, "cup_drinker")?.status).toBe("priced");
    expect(lineOf(q1.draft, "pvc_door")?.status).toBe("priced");
    expect(lineOf(q1.draft, "pvc_door")?.sku).toBe("NQ3444");
  });
  it("the cup drinker is never priced by a bulk confirmation: without the explicit confirmation it stays unpriced even with every component costed", async () => {
    const id = await priced();
    (db.rows("newquip_quotes").find((r) => r.id === id) as Record<string, unknown>).state = "ESTIMATOR_REVIEW";
    await runAutoPricingTopUp(db as never, EST, id, deps(), ON);
    const q = await load(id);
    expect(Object.keys(q.draft.estimator.pricing!.skus)).toContain("QCA00003");
    expect(q.draft.estimator.confirmedPackages).not.toContain("cup_drinker");
    expect(lineOf(q.draft, "cup_drinker")?.status).not.toBe("priced");
    expect(skuNeedsOf(evaluateDraft(q.draft, { priceSource: testPriceSource(), withholdCost: true }).budget).map((n) => n.sku)).toContain("QCA00003");
  });
});
