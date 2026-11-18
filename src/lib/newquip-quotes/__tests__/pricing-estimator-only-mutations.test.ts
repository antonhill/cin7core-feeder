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
import { createQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "../quote-store";
import { applyPricingChange, loadPricingWorkspace, recordManualEvidence, verifyCosts, type PricingActor } from "../pricing-service";
import { listPricingRevisions } from "../pricing-store";

// Estimator-only pricing mutations at the SERVER boundary: a Manager-only account (cost-entitled, role set {manager}) cannot enable/disable supplier pricing or change a supplier
// cost, FX rate, freight assumption, markup, evidence or revision, whatever the UI shows. It CAN still independently verify costs (it never entered them). Entering still needs the
// Estimator role; an actor who holds both roles still cannot verify a cost they entered themselves. Approved quotations stay immutable.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member"), admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const estimator = (over: Partial<PricingActor> = {}): PricingActor => ({ orgId: ORG, userId: "u-est", email: "est@nq", roles: new Set(["rep", "estimator"]), canSeeCost: true, ...over });
const managerOnly = (over: Partial<PricingActor> = {}): PricingActor => ({ orgId: ORG, userId: "u-mgr", email: "mgr@nq", roles: new Set(["manager"]), canSeeCost: true, ...over });
let db: FakeDb;
const loaded = async (id: string) => (await loadQuote(db as never, ORG, id))!;
const submissionOf = (over: Partial<PricingSubmission> = {}): PricingSubmission => {
  const s = structuredClone(equivalentInputs({}, "unverified"));
  return { ruleVersionId: s.ruleVersionId, skus: Object.fromEntries(Object.entries(s.skus).map(([k, v]) => { const { by: _b, at: _a, ...rest } = v!; void _b; void _a; return [k, rest as never]; })), fxQuotes: s.fxQuotes as never, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null, ...over };
};
async function inReview(): Promise<string> {
  const d = readyDraft();
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  const total = Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);
  await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
  return id;
}
const snapshotOf = async (id: string) => ({ hash: (await loaded(id)).draft_hash, pricing: JSON.stringify((await loaded(id)).draft.estimator.pricing ?? null), revisions: (await listPricingRevisions(db as never, ORG, id)).length, state: (await loaded(id)).state });

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; seedGoldenCatalogue(db as never, ORG); });

describe("a Manager-only account cannot mutate Estimator pricing (server boundary)", () => {
  it("cannot switch supplier pricing ON", async () => {
    const id = await inReview();
    const before = await snapshotOf(id);
    expect(await applyPricingChange(db as never, managerOnly(), id, submissionOf(), "Manager tries to enable")).toMatchObject({ ok: false, errors: [expect.stringMatching(/Only an Estimator/)] });
    expect(await snapshotOf(id)).toEqual(before);
  });
  it("cannot change a supplier cost, an FX rate, a freight assumption or the markup, nor switch pricing OFF, nor edit evidence; nothing is written", async () => {
    const id = await inReview();
    expect(await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing")).toMatchObject({ ok: true });
    const before = await snapshotOf(id);
    const base = submissionOf();
    const firstSku = Object.keys(base.skus)[0];
    const fxCur = Object.keys(base.fxQuotes)[0];
    const attempts: Array<[string, PricingSubmission | null]> = [
      ["cost", { ...base, skus: { ...base.skus, [firstSku]: { ...base.skus[firstSku], nativeUnitCostE7: base.skus[firstSku].nativeUnitCostE7 + 10_000_000 } } }],
      ["freight", { ...base, skus: { ...base.skus, [firstSku]: { ...base.skus[firstSku], freight: { factorMicro: micro("2"), source: "Manager" } } } }],
      ["fx", { ...base, fxQuotes: { ...base.fxQuotes, [fxCur]: { ...base.fxQuotes[fxCur], rateMicro: micro("25") } } }],
      ["markup", { ...base, projectMarkup: { markupBps: 3000, reason: "Manager markup" } }],
      ["unchanged resubmission", base],
      ["disable", null],
    ];
    for (const [what, sub] of attempts) {
      expect(await applyPricingChange(db as never, managerOnly(), id, sub, `Manager tries: ${what}`), what).toMatchObject({ ok: false, errors: [expect.stringMatching(/Only an Estimator/)] });
    }
    expect(await snapshotOf(id)).toEqual(before);
  });
  it("cannot record pricing evidence for manual items", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing");
    const before = await snapshotOf(id);
    const r = await recordManualEvidence(db as never, managerOnly(), id, evidenceItemsFor((await loaded(id)).draft));
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/Only an Estimator/)] });
    expect(await snapshotOf(id)).toEqual(before);
  });
  it("the workspace tells a Manager-only viewer it cannot edit, but offers every cost for independent verification", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing");
    const w = await loadPricingWorkspace(db as never, managerOnly(), id);
    expect(w.canEdit).toBe(false);
    expect(w.verification.canReview).toBe(true);
    expect(w.verification.verifiableSkus.length).toBeGreaterThan(0);
    expect((await loadPricingWorkspace(db as never, estimator(), id)).canEdit).toBe(true);
  });
});

describe("what is preserved", () => {
  it("a Manager-only account CAN independently verify costs: one immutable revision, attributed to the Manager, no cost/FX/freight/price value changes", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing");
    const p0 = (await loaded(id)).draft.estimator.pricing!;
    const r = await verifyCosts(db as never, managerOnly(), id, itemsOf(p0, Object.keys(p0.skus)), "Supplier quote SQ-1");
    expect(r).toMatchObject({ ok: true, report: { seq: 2 } });
    const p1 = (await loaded(id)).draft.estimator.pricing!;
    for (const k of Object.keys(p0.skus)) {
      const { review, ...rest } = p1.skus[k]!; const { review: _r, ...was } = p0.skus[k]!; void _r;
      expect(review).toMatchObject({ by: "mgr@nq", evidence: "Supplier quote SQ-1" });
      expect(rest).toEqual(was);
    }
    expect(p1.fxQuotes).toEqual(p0.fxQuotes);
    expect(p1.projectMarkup).toEqual(p0.projectMarkup);
    const revs = await listPricingRevisions(db as never, ORG, id);
    expect(revs[1].changes.every((c) => /\.review\./.test(c.path))).toBe(true);
  });
  it("a Rep or a cost-blind Estimator still cannot verify; an Estimator-only account still enters", async () => {
    const id = await inReview();
    expect(await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing")).toMatchObject({ ok: true });
    const p = (await loaded(id)).draft.estimator.pricing!;
    for (const a of [estimator({ email: "other@nq" }), managerOnly({ canSeeCost: false })]) {
      expect(await verifyCosts(db as never, a, id, itemsOf(p, Object.keys(p.skus)), "Supplier quote SQ-1")).toMatchObject({ ok: false });
    }
    expect(await applyPricingChange(db as never, estimator(), id, submissionOf({ projectMarkup: { markupBps: 2500, reason: "Estimator markup" } }), "Estimator edit")).toMatchObject({ ok: true });
  });
  it("separation of duties: an owner holding BOTH roles can enter, but cannot verify a cost they entered", async () => {
    const id = await inReview();
    const both = managerOnly({ roles: new Set(["rep", "estimator", "manager"]), email: "owner@nq" });
    expect(await applyPricingChange(db as never, both, id, submissionOf(), "Owner enters costs")).toMatchObject({ ok: true });
    const p = (await loaded(id)).draft.estimator.pricing!;
    expect(await verifyCosts(db as never, both, id, itemsOf(p, Object.keys(p.skus)), "Supplier quote SQ-1")).toMatchObject({ ok: false, errors: expect.arrayContaining([expect.stringMatching(/you entered or last changed this cost/)]) });
  });
  it("an approved quotation stays immutable for the Estimator, the Manager-only account and verification alike", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf({}), "Initial supplier pricing");
    const p = (await loaded(id)).draft.estimator.pricing!;
    expect(await verifyCosts(db as never, managerOnly(), id, itemsOf(p, Object.keys(p.skus)), "Supplier quote SQ-1")).toMatchObject({ ok: true });
    expect(await recordManualEvidence(db as never, estimator(), id, evidenceItemsFor((await loaded(id)).draft))).toMatchObject({ ok: true });
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    await managerApprove(db as never, ORG, admin, "mgr@nq", id, ctx);
    const before = await snapshotOf(id);
    expect(await applyPricingChange(db as never, estimator(), id, submissionOf({ projectMarkup: { markupBps: 3000, reason: "late" } }), "Too late")).toMatchObject({ ok: false });
    expect(await applyPricingChange(db as never, managerOnly(), id, submissionOf({ projectMarkup: { markupBps: 3000, reason: "late" } }), "Too late")).toMatchObject({ ok: false });
    expect(await snapshotOf(id)).toEqual(before);
  });
});
