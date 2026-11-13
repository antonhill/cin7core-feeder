import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { equivalentInputs, evidenceItemsFor, itemsOf, withPricing } from "@/newquip/pricing/estimator/__tests__/helpers";
import { submissionFrom, type PricingSubmission } from "@/newquip/pricing/estimator";
import { createQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "../quote-store";
import { applyPricingChange, loadPricingWorkspace, recordManualEvidence, verifyCosts, type PricingActor } from "../pricing-service";
import { listPricingRevisions } from "../pricing-store";

// NQ-008B hardening, store level (FakeDb emulating 0123 and 0126): independent verification, concurrent updates, tenant isolation, approved-quote immutability, clearing a cost,
// manual prices that would conceal a missing cost. Nothing here talks to Cin7: every write is to a NewQuip table.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq", OTHER_ORG = "org-other";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member"), admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const actor = (email: string, roles: Array<"rep" | "estimator" | "manager">, over: Partial<PricingActor> = {}): PricingActor => ({ orgId: ORG, userId: `u-${email}`, email, roles: new Set(roles), canSeeCost: true, ...over });
const estimator = actor("est@nq", ["rep", "estimator"]);
const manager1 = actor("mgr1@nq", ["rep", "estimator", "manager"]);
const manager2 = actor("mgr2@nq", ["rep", "estimator", "manager"]);
let db: FakeDb;
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);
const cents = (d: QuoteDraft) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);
const loaded = async (id: string) => (await loadQuote(db as never, ORG, id))!;
const sub = (over: (s: PricingSubmission) => void = () => undefined): PricingSubmission => { const s = structuredClone(submissionFrom(equivalentInputs({}, "unverified"))); over(s); return s; };

async function inReview(draft: QuoteDraft = readyDraft()): Promise<{ id: string; total: number }> {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, draft);
  const total = cents(draft);
  await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
  return { id, total };
}
const skusOf = async (id: string) => Object.keys((await loaded(id)).draft.estimator.pricing!.skus);
/** What the reviewer sees when they open the workspace: every SKU with the hash of the cost on screen. */
const itemsFor = async (id: string, skus?: string[]) => itemsOf((await loaded(id)).draft.estimator.pricing, skus ?? (await skusOf(id)));
const verifyAll = async (id: string, a: PricingActor = manager1, evidence = "Supplier quote SQ-1") => verifyCosts(db as never, a, id, await itemsFor(id), evidence);

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; seedGoldenCatalogue(db as never, ORG); });

describe("independent verification, end to end", () => {
  it("verifying changes no price, leaves the Rep's confirmation alone, withdraws the Estimator sign-off, and is one attributed immutable revision", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const total = cents((await loaded(id)).draft);
    await db.from("newquip_quotes").update({ customer_confirmed_cents: total }).eq("id", id); // (the amount the Rep confirmed equals the model total here)
    const before = await loaded(id);
    expect(await verifyAll(id)).toMatchObject({ ok: true });
    const q = await loaded(id);
    expect(cents(q.draft)).toBe(total);
    expect(q).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: before.customer_confirmed_cents, estimator_signoff_hash: null });
    const revs = await listPricingRevisions(db as never, ORG, id);
    expect(revs.map((r) => [r.seq, r.changedBy])).toEqual([[1, "est@nq"], [2, "mgr1@nq"]]);
    expect(revs[1].reason).toBe("Independent cost verification: Supplier quote SQ-1");
  });
  it("the person who entered the costs cannot verify them, an Estimator-only reviewer cannot, and a reviewer who then EDITS a cost cannot verify that cost", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    expect(await verifyAll(id, actor("est@nq", ["rep", "estimator", "manager"]))).toMatchObject({ ok: false });
    expect(await verifyAll(id, actor("other.est@nq", ["rep", "estimator"]))).toMatchObject({ ok: false });
    expect(await verifyAll(id, actor("mgr1@nq", ["manager"], { canSeeCost: false }))).toMatchObject({ ok: false });
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(1);
    // manager1 corrects a cost: they become the person who last changed it
    const q = await loaded(id);
    const edit = submissionFrom(q.draft.estimator.pricing!); edit.skus.PNQ082 = { ...edit.skus.PNQ082, nativeUnitCostMicro: edit.skus.PNQ082.nativeUnitCostMicro + 1_000_000 };
    expect(await applyPricingChange(db as never, manager1, id, edit, "Corrected the feeder cost")).toMatchObject({ ok: true });
    const mine = await verifyCosts(db as never, manager1, id, await itemsFor(id, ["PNQ082"]), "Quote SQ-2");
    expect(mine).toMatchObject({ ok: false, errors: [expect.stringMatching(/you entered or last changed this cost/)] });
    expect(await verifyCosts(db as never, manager2, id, await itemsFor(id, ["PNQ082"]), "Quote SQ-2")).toMatchObject({ ok: true }); // a different reviewer may
  });
  it("the workspace tells each viewer which costs THEY may verify (never ones they entered), and an Estimator-only viewer none", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const asEst = await loadPricingWorkspace(db as never, estimator, id);
    expect(asEst.verification).toMatchObject({ canReview: false, verifiableSkus: [] });
    const asMgr = await loadPricingWorkspace(db as never, manager1, id);
    expect(asMgr.verification.canReview).toBe(true);
    expect(asMgr.verification.verifiableSkus).toEqual((await skusOf(id)).sort());
    const asEnteredByManager = await loadPricingWorkspace(db as never, actor("est@nq", ["rep", "estimator", "manager"]), id);
    expect(asEnteredByManager.verification).toMatchObject({ canReview: true, verifiableSkus: [] }); // holds the role, but entered every cost
    expect(asMgr.view.rows.every((r) => r.costState === "unverified" && r.enteredBy === "est@nq")).toBe(true);
  });
});

describe("a cost change after verification, and clearing a cost", () => {
  it("any change to a verified cost removes ITS verification only, and sign-off is blocked until it is verified again", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    await verifyAll(id);
    const before = await loadPricingWorkspace(db as never, manager1, id);
    expect(before.view.costs.verified).toBe(before.view.costs.required);
    const edit = submissionFrom((await loaded(id)).draft.estimator.pricing!); edit.skus.NQ1017 = { ...edit.skus.NQ1017, supplierName: "A different supplier" };
    await applyPricingChange(db as never, estimator, id, edit, "Switched supplier for the drinker nipple");
    const after = await loadPricingWorkspace(db as never, manager1, id);
    expect(after.view.rows.find((r) => r.sku === "NQ1017")).toMatchObject({ costState: "unverified", enteredBy: "est@nq", review: null });
    expect(after.view.rows.find((r) => r.sku === "PNQ082")!.costState).toBe("verified");
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/NQ1017: the supplier cost has not been independently verified/);
  });
  it("clearing a cost is a recorded revision (previous -> null), the SKU is then NOT priced, and a zero cost is refused", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const clear = sub((s) => { delete s.skus.SYSH; delete s.skus["SYSH-2750-3"]; });
    expect(await applyPricingChange(db as never, estimator, id, clear, "Cleared the bulk tank cost: the supplier withdrew the quote")).toMatchObject({ ok: true });
    const revs = await listPricingRevisions(db as never, ORG, id);
    expect(revs[1].changes.some((c) => c.path === "skus.SYSH-2750-3.nativeUnitCostMicro" && c.new === null && c.previous !== null)).toBe(true);
    const ws = await loadPricingWorkspace(db as never, estimator, id);
    expect(ws.view.rows.find((r) => r.sku === "SYSH-2750-3")).toMatchObject({ status: "no_input", costState: "missing", unitPriceCents: null });
    expect(ws.view.totals.totalCents).toBeNull();
    const zero = sub((s) => { s.skus["SYSH-2750-3"] = { ...s.skus.PNQ082, nativeUnitCostMicro: 0 }; });
    expect(await applyPricingChange(db as never, estimator, id, zero, "Zero cost attempt")).toMatchObject({ ok: false, errors: [expect.stringMatching(/a zero supplier cost is not a cost/)] });
  });
});

describe("concurrent updates", () => {
  it("two reviewers verifying at once: exactly one revision is recorded, the other is told to refresh", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const [a, b] = await Promise.all([verifyAll(id, manager1), verifyAll(id, manager2)]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    const loser = a.ok ? b : a;
    expect(loser).toMatchObject({ ok: false, errors: [expect.stringMatching(/changed while you were editing/)] });
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(2);
  });
  it("a reviewer who opened the workspace BEFORE an Estimator changed a cost can never verify the changed cost: the verification is bound to the cost they saw", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const seen = await itemsFor(id); // what the reviewer has on screen
    const edit = submissionFrom((await loaded(id)).draft.estimator.pricing!); edit.skus.PNQ082 = { ...edit.skus.PNQ082, nativeUnitCostMicro: edit.skus.PNQ082.nativeUnitCostMicro + 2_000_000 };
    expect(await applyPricingChange(db as never, estimator, id, edit, "Re-quoted feeder")).toMatchObject({ ok: true });
    const r = await verifyCosts(db as never, manager1, id, seen, "Quote SQ-1");
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/PNQ082: the cost changed after you opened it/)] });
    expect((await loaded(id)).draft.estimator.pricing!.skus.PNQ082!.review).toBeUndefined();
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(2); // nothing was recorded for the refused request
    // opening the CURRENT cost and reviewing that works
    expect(await verifyCosts(db as never, manager1, id, await itemsFor(id), "Quote SQ-1b")).toMatchObject({ ok: true });
  });
  it("an Estimator edit and a verification fired at the same moment: whichever lands second is refused or covers only what is stored", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const seen = await itemsFor(id);
    const edit = submissionFrom((await loaded(id)).draft.estimator.pricing!); edit.skus.PNQ082 = { ...edit.skus.PNQ082, nativeUnitCostMicro: edit.skus.PNQ082.nativeUnitCostMicro + 3_000_000 };
    const [v, e] = await Promise.all([verifyCosts(db as never, manager1, id, seen, "Quote SQ-1"), applyPricingChange(db as never, estimator, id, edit, "Re-quoted feeder")]);
    const st = (await loaded(id)).draft.estimator.pricing!.skus.PNQ082!;
    // a verification of the OLD cost can never end up attached to the NEW cost
    if (e.ok) expect(v.ok && st.review ? st.review.inputHash === JSON.stringify(null) : true).toBe(true);
    expect(st.review === undefined || st.review.by === "mgr1@nq").toBe(true);
    expect([v.ok, e.ok].some(Boolean)).toBe(true);
  });
  it("a stale draft save (a Rep/Estimator editor that loaded before a verification) cannot overwrite the verification", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const stale = (await loaded(id)).draft;
    await verifyAll(id);
    const row = db.rows("newquip_quotes")[0] as Record<string, unknown>;
    const from = db.from.bind(db) as (t: string) => Record<string, (...a: unknown[]) => unknown>;
    (db as unknown as { from: unknown }).from = (t: string) => { const b = from(t); if (t === "newquip_quotes") { const upd = b.update.bind(b); b.update = (...a: unknown[]) => { db.tables.newquip_quotes[0] = { ...row, draft_hash: "moved-by-another-writer" }; return upd(...a); }; } return b; };
    expect(await err(saveDraft(db as never, ORG, member, id, { ...stale, siteName: "Edited" }))).toMatch(/changed while you were editing/);
    expect((await loaded(id)).draft.estimator.pricing!.skus.PNQ082!.review).toBeDefined();
  });
});

describe("server writers can never overwrite pricing / verification with an older copy of the draft", () => {
  it("saveDraft with keepStoredPricing takes the pricing from the row it loads, so a clone made BEFORE a verification cannot revert it", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const clone = structuredClone((await loaded(id)).draft); // a server writer cloned the draft here...
    await verifyAll(id); // ...and a verification revision landed before it saved
    await saveDraft(db as never, ORG, rolesFor("admin"), id, { ...clone, siteName: "Edited by a cost writer" }, undefined, { keepStoredPricing: true });
    const after = await loaded(id);
    expect(after.draft.siteName).toBe("Edited by a cost writer");
    expect(Object.values(after.draft.estimator.pricing!.skus).every((s) => s!.review?.by === "mgr1@nq")).toBe(true); // the verification survived
    expect(after.draft.estimator.pricing!.revision).toBe(2);
  });
});

describe("tenant isolation and approved-quote immutability", () => {
  it("another organisation can neither read, change nor verify this quotation's pricing, and sees none of its revisions", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    const outsider = actor("mgr@other", ["rep", "estimator", "manager"], { orgId: OTHER_ORG });
    expect(await err(loadPricingWorkspace(db as never, outsider, id))).toMatch(/Quote not found/);
    expect(await applyPricingChange(db as never, outsider, id, sub(), "Cross-org attempt")).toMatchObject({ ok: false, errors: ["Quote not found."] });
    expect(await verifyCosts(db as never, outsider, id, await itemsFor(id, ["PNQ082"]), "Cross-org attempt")).toMatchObject({ ok: false, errors: ["Quote not found."] });
    expect(await listPricingRevisions(db as never, OTHER_ORG, id)).toEqual([]);
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(1);
  });
  it("an approved quotation can be neither repriced nor re-verified, and its sealed baseline keeps who verified what", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing");
    await verifyAll(id);
    expect(await recordManualEvidence(db as never, estimator, id, evidenceItemsFor((await loaded(id)).draft))).toMatchObject({ ok: true });
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    await managerApprove(db as never, ORG, admin, "mgr1@nq", id, ctx);
    expect(await verifyCosts(db as never, manager2, id, await itemsFor(id, ["PNQ082"]), "Late")).toMatchObject({ ok: false, errors: [expect.stringMatching(/approved/)] });
    expect(await applyPricingChange(db as never, estimator, id, sub((s) => { s.projectMarkup = { markupBps: 3000, reason: "late" }; }), "Too late")).toMatchObject({ ok: false, errors: [expect.stringMatching(/approved/)] });
    const q = await loaded(id);
    expect(Object.values(q.accepted_baseline!.estimator.pricing!.skus).every((s) => s!.review?.by === "mgr1@nq" && s!.by === "est@nq")).toBe(true);
  });
});

describe("a manual price never conceals a missing or unverified supplier cost", () => {
  it("model on, ERT053 priced by a manual resolution with NO supplier cost: the price is complete but sign-off and approval are blocked even after everything else is verified", async () => {
    const d = withPricing(equivalentInputs({}, "unverified"), (() => { const x = readyDraft(); x.estimator.priceResolutions = { ...x.estimator.priceResolutions, feed_saver_mat: { unitPriceExVat: 919, reason: "Manual price: none in the workbook" } }; return x; })());
    delete d.estimator.pricing!.skus.ERT053;
    const { id } = await inReview(d);
    expect(evaluateDraft((await loaded(id)).draft, ctx).budget!.incomplete).toBe(false); // PRICE complete
    expect(await verifyAll(id)).toMatchObject({ ok: true }); // every recorded cost verified independently
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/ERT053: priced by a manual price, but no supplier cost has been entered/);
    const ws = await loadPricingWorkspace(db as never, manager1, id);
    expect(ws.view.rows.find((r) => r.sku === "ERT053")).toMatchObject({ priceBasis: "manual_price", costState: "missing" });
    expect(ws.view.totals.priceComplete).toBe(true);
    expect(ws.view.finality.final).toBe(false);
    expect(await err(managerApprove(db as never, ORG, admin, "mgr1@nq", id, ctx))).toMatch(/manual price|Costing is incomplete|has not signed off/);
    // recording the cost and having it verified independently clears it
    const q = await loaded(id);
    const add = submissionFrom(q.draft.estimator.pricing!); add.skus.ERT053 = { ...add.skus.PNQ082, supplierName: "Mat supplier", nativeUnitCostMicro: 90_000_000, source: "Quote SQ-MAT" };
    expect(await applyPricingChange(db as never, estimator, id, add, "Recorded the mat supplier cost")).toMatchObject({ ok: true });
    expect(await verifyCosts(db as never, manager1, id, await itemsFor(id, ["ERT053"]), "Quote SQ-MAT")).toMatchObject({ ok: true });
  });
});
