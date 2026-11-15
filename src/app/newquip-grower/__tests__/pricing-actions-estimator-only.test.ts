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

// The Server Actions themselves (not the UI): authorisation is re-established inside each one, so a hand-crafted call from a Manager-only session is refused and writes nothing,
// while the Manager's independent cost verification and an Estimator's own pricing operations keep working.
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

describe("direct server-action calls from a Manager-only session", () => {
  it("applyEstimatorPricingAction cannot enable, change cost / freight / FX / markup, and writes nothing", async () => {
    const id = await inReview();
    actor = MGR_ONLY();
    const empty = await state(id);
    expect(await actions.applyEstimatorPricingAction(id, submissionOf(), "Manager enables")).toMatchObject({ ok: false, error: expect.stringMatching(/Only an Estimator/) });
    expect(await state(id)).toEqual(empty);
    actor = EST();
    expect((await actions.applyEstimatorPricingAction(id, submissionOf(), "Initial supplier pricing")).ok).toBe(true);
    const base = submissionOf(), sku = Object.keys(base.skus)[0], cur = Object.keys(base.fxQuotes)[0];
    const before = await state(id);
    actor = MGR_ONLY();
    for (const sub of [
      { ...base, skus: { ...base.skus, [sku]: { ...base.skus[sku], nativeUnitCostE7: base.skus[sku].nativeUnitCostE7 * 2 } } },
      { ...base, skus: { ...base.skus, [sku]: { ...base.skus[sku], freight: { factorMicro: micro("3"), source: "Manager" } } } },
      { ...base, fxQuotes: { ...base.fxQuotes, [cur]: { ...base.fxQuotes[cur], rateMicro: micro("30") } } },
      { ...base, projectMarkup: { markupBps: 4000, reason: "Manager" } },
    ] as PricingSubmission[]) expect(await actions.applyEstimatorPricingAction(id, sub, "Manager edit")).toMatchObject({ ok: false, error: expect.stringMatching(/Only an Estimator/) });
    expect(await state(id)).toEqual(before);
  });
  it("disableEstimatorPricingAction cannot switch pricing off", async () => {
    const id = await inReview();
    actor = EST();
    await actions.applyEstimatorPricingAction(id, submissionOf(), "Initial supplier pricing");
    const before = await state(id);
    actor = MGR_ONLY();
    expect(await actions.disableEstimatorPricingAction(id, "Manager disables")).toMatchObject({ ok: false, error: expect.stringMatching(/Only an Estimator/) });
    expect(await state(id)).toEqual(before);
    expect((await loaded(id)).draft.estimator.pricing).toMatchObject({ enabled: true });
  });
  it("recordManualPriceEvidenceAction cannot record evidence", async () => {
    const id = await inReview();
    actor = EST();
    await actions.applyEstimatorPricingAction(id, submissionOf(), "Initial supplier pricing");
    const before = await state(id);
    actor = MGR_ONLY();
    const items = evidenceItemsFor((await loaded(id)).draft).map((i) => ({ itemKey: i.itemKey, note: "Manager note" }));
    expect(await actions.recordManualPriceEvidenceAction(id, items)).toMatchObject({ ok: false, error: expect.stringMatching(/Only an Estimator/) });
    expect(await state(id)).toEqual(before);
  });
  it("a Rep, or a cost-blind account of any role, is refused every pricing action", async () => {
    const id = await inReview();
    for (const a of [asActor("rep@nq", ["rep"], { canSeeCost: false }), asActor("mgr@nq", ["manager"], { canSeeCost: false }), asActor("est@nq", ["rep", "estimator"], { canSeeCost: false })]) {
      actor = a;
      expect((await actions.applyEstimatorPricingAction(id, submissionOf(), "x")).ok).toBe(false);
      expect((await actions.getEstimatorPricingAction(id)).ok).toBe(false);
    }
    expect((await loaded(id)).draft.estimator.pricing).toBeUndefined();
  });
});

describe("preserved through the same server actions", () => {
  it("the Estimator enters; the Manager-only session reads the workspace (canEdit false) and independently verifies; the Estimator cannot verify their own cost", async () => {
    const id = await inReview();
    actor = EST();
    expect(await actions.applyEstimatorPricingAction(id, submissionOf(), "Initial supplier pricing")).toMatchObject({ ok: true });
    const p = (await loaded(id)).draft.estimator.pricing!;
    const items = itemsOf(p, Object.keys(p.skus));
    expect(await actions.verifyEstimatorCostsAction(id, items, "Supplier quote SQ-1")).toMatchObject({ ok: false });
    actor = MGR_ONLY();
    const ws = await actions.getEstimatorPricingAction(id);
    expect(ws).toMatchObject({ ok: true, data: { canEdit: false } });
    expect(await actions.verifyEstimatorCostsAction(id, items, "Supplier quote SQ-1")).toMatchObject({ ok: true, data: { seq: 2 } });
    const after = (await loaded(id)).draft.estimator.pricing!;
    expect(Object.values(after.skus).every((s) => s!.review?.by === "mgr@nq")).toBe(true);
    expect(after.fxQuotes).toEqual(p.fxQuotes);
  });
});
