import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { cost7 } from "@/newquip/pricing/model";
import type { PricingSubmission } from "@/newquip/pricing/estimator/apply";
import { changedOwners, mergePricing, samePricingValue } from "@/newquip/pricing/estimator";
import { equivalentInputs } from "@/newquip/pricing/estimator/__tests__/helpers";
import { createQuote, loadQuote, saveDraft, sendToEstimator } from "../quote-store";
import { applyPricingChange, loadPricingWorkspace, type PricingActor } from "../pricing-service";
import { listPricingRevisions } from "../pricing-store";

// REGRESSION: no silent cost overwrite. Estimator A holds a whole local draft; Estimator B saves a change to SKU X; A saves. Before the fix B's X was silently reverted. The save now carries the
// stored pricing A's edits were based on, and the server merges field by field (untouched fields take the CURRENT stored value; a field both changed differently refuses the save).
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const A: PricingActor = { orgId: ORG, userId: "u-a", email: "a@nq", roles: new Set(["rep", "estimator"]), canSeeCost: true };
const B: PricingActor = { orgId: ORG, userId: "u-b", email: "b@nq", roles: new Set(["rep", "estimator"]), canSeeCost: true };
let db: FakeDb;
const submissionOf = (): PricingSubmission => {
  const s = structuredClone(equivalentInputs({}, "unverified"));
  return { ruleVersionId: s.ruleVersionId, skus: Object.fromEntries(Object.entries(s.skus).map(([k, v]) => { const { by: _b, at: _a, ...rest } = v!; void _b; void _a; return [k, rest as never]; })), fxQuotes: s.fxQuotes as never, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null };
};
async function inReview(): Promise<string> {
  const d = readyDraft();
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100), confirmedBy: "Farmer Joe" });
  return id;
}
const stored = async (id: string) => (await loadQuote(db as never, ORG, id))!.draft.estimator.pricing!;
const revs = async (id: string) => (await listPricingRevisions(db as never, ORG, id)).length;
/** What a panel holds after loading: the stored inputs as its base AND as its editable draft. */
const load = async (id: string, who: PricingActor) => { const c = (await loadPricingWorkspace(db as never, who, id)).current!; return { base: structuredClone(c), draft: structuredClone(c) }; };
let X: string, Y: string;

beforeEach(async () => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; seedGoldenCatalogue(db as never, ORG); [X, Y] = Object.keys(submissionOf().skus); });

describe("stale save: field-level three-way merge on the server", () => {
  it("B's change to X survives A's save of a DIFFERENT field; A's own edit is applied; untouched fields take the current stored values; E7 values are exact", async () => {
    const id = await inReview();
    expect((await applyPricingChange(db as never, A, id, submissionOf(), "Initial supplier pricing")).ok).toBe(true);
    const a = await load(id, A); // A has the page open
    const b = await load(id, B);
    b.draft.skus[X].nativeUnitCostE7 = cost7("6.5454755"); // B saves a new cost for X
    expect((await applyPricingChange(db as never, B, id, b.draft, "B corrects X", b.base)).ok).toBe(true);
    a.draft.skus[Y].nativeUnitCostE7 = cost7("1.2345678"); // A (stale for X) edits Y only and saves the WHOLE draft with a fresh server read
    const r = await applyPricingChange(db as never, A, id, a.draft, "A corrects Y", a.base);
    expect(r).toMatchObject({ ok: true });
    const p = await stored(id);
    expect(p.skus[X]!.nativeUnitCostE7).toBe(65_454_755); // B's value NOT reverted (exact E7 integer)
    expect(p.skus[X]!.by).toBe("b@nq"); // and still attributed to B
    expect(p.skus[Y]!.nativeUnitCostE7).toBe(12_345_678);
    expect(p.skus[Y]!.by).toBe("a@nq");
    expect(await revs(id)).toBe(3);
    const last = (await listPricingRevisions(db as never, ORG, id))[2];
    expect(last.changes.map((c) => c.path)).toEqual([`skus.${Y}.nativeUnitCostE7`]); // A's revision records ONLY A's change
  });
  it("the same field changed differently by both is REFUSED with a plain message naming SKU, field, who and when; nothing is written", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, A, id, submissionOf(), "Initial supplier pricing");
    const a = await load(id, A), b = await load(id, B);
    b.draft.skus[X].nativeUnitCostE7 = cost7("7.1000001");
    await applyPricingChange(db as never, B, id, b.draft, "B changes X", b.base);
    const before = JSON.stringify(await stored(id)); const n = await revs(id);
    a.draft.skus[X].nativeUnitCostE7 = cost7("8.2000002");
    const r = await applyPricingChange(db as never, A, id, a.draft, "A changes X", a.base);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toMatch(new RegExp(`SKU ${X} cost was changed by b@nq at 20\\d\\d-`));
    expect(r.errors[0]).toMatch(/Reload to review/);
    expect(r.conflicts).toEqual([expect.objectContaining({ key: `sku:${X}:nativeUnitCostE7`, by: "b@nq" })]);
    expect(JSON.stringify(await stored(id))).toBe(before);
    expect(await revs(id)).toBe(n);
  });
  it("different fields of the SAME SKU merge (A edits the supplier name, B the cost); an identical concurrent edit is not a conflict", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, A, id, submissionOf(), "Initial supplier pricing");
    const a = await load(id, A), b = await load(id, B);
    b.draft.skus[X].nativeUnitCostE7 = cost7("9.9999999");
    await applyPricingChange(db as never, B, id, b.draft, "B cost", b.base);
    a.draft.skus[X].supplierName = "Renamed Supplier";
    expect((await applyPricingChange(db as never, A, id, a.draft, "A name", a.base)).ok).toBe(true);
    const p = await stored(id);
    expect(p.skus[X]).toMatchObject({ nativeUnitCostE7: 99_999_999, supplierName: "Renamed Supplier" });
    // both set Y to the same value: no conflict
    const a2 = await load(id, A), b2 = await load(id, B);
    a2.draft.skus[Y].nativeUnitCostE7 = b2.draft.skus[Y].nativeUnitCostE7 = cost7("3.3333333");
    expect((await applyPricingChange(db as never, B, id, b2.draft, "B Y", b2.base)).ok).toBe(true);
    expect((await applyPricingChange(db as never, A, id, a2.draft, "A Y", a2.base))).toMatchObject({ ok: false, errors: ["Nothing changed."] });
  });
  it("a draft whose base is null (pricing was off when loaded) cannot overwrite pricing another estimator enabled meanwhile", async () => {
    const id = await inReview();
    const mine = submissionOf(); mine.skus[X].nativeUnitCostE7 = cost7("1.5");
    await applyPricingChange(db as never, B, id, submissionOf(), "B enables");
    const r = await applyPricingChange(db as never, A, id, mine, "A enables", null);
    expect(r).toMatchObject({ ok: false, conflicts: [expect.objectContaining({ key: `sku:${X}`, by: "b@nq" })] });
    expect((await stored(id)).skus[X]!.nativeUnitCostE7).toBe(submissionOf().skus[X].nativeUnitCostE7);
  });
  it("a switch-off by someone else since the base refuses the save (never silently re-enabled)", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, A, id, submissionOf(), "Initial supplier pricing");
    const a = await load(id, A);
    expect((await applyPricingChange(db as never, B, id, null, "B switches off")).ok).toBe(true);
    a.draft.skus[X].nativeUnitCostE7 = cost7("2");
    expect(await applyPricingChange(db as never, A, id, a.draft, "A edit", a.base)).toMatchObject({ ok: false, errors: [expect.stringMatching(/switched off by someone else/)] });
  });
  it("without a base the submission is applied exactly as before (backward compatible)", async () => {
    const id = await inReview();
    await applyPricingChange(db as never, A, id, submissionOf(), "Initial supplier pricing");
    const x = submissionOf(); x.skus[X].nativeUnitCostE7 = cost7("4.4444444");
    expect((await applyPricingChange(db as never, B, id, x, "Legacy whole-draft save")).ok).toBe(true);
    expect((await stored(id)).skus[X]!.nativeUnitCostE7).toBe(44_444_444);
  });
});

describe("mergePricing (pure)", () => {
  const base = submissionOf();
  it("takes stored for untouched, draft for own edits, flags real conflicts; compares exact values", () => {
    const s = structuredClone(base); s.skus[X].nativeUnitCostE7 += 1; s.projectMarkup = { markupBps: 500, reason: "stored" };
    const d = structuredClone(base); d.skus[Y].nativeUnitCostE7 += 1;
    const m = mergePricing(base, s, d);
    expect(m.conflicts).toEqual([]);
    expect(m.merged.skus[X].nativeUnitCostE7).toBe(base.skus[X].nativeUnitCostE7 + 1);
    expect(m.merged.skus[Y].nativeUnitCostE7).toBe(base.skus[Y].nativeUnitCostE7 + 1);
    expect(m.merged.projectMarkup).toEqual({ markupBps: 500, reason: "stored" });
    d.skus[X].nativeUnitCostE7 += 2;
    expect(mergePricing(base, s, d).conflicts.map((c) => c.key)).toEqual([`sku:${X}:nativeUnitCostE7`]);
  });
  it("dirty tracking is a diff: an identical value is not a change", () => {
    const d = structuredClone(base);
    expect(changedOwners(base, d)).toEqual([]);
    expect(samePricingValue({ a: 1, by: "x" }, { a: 1, by: "y" })).toBe(true);
    d.skus[X].nativeUnitCostE7 += 1;
    expect(changedOwners(base, d)).toEqual([`sku:${X}`]);
  });
});
