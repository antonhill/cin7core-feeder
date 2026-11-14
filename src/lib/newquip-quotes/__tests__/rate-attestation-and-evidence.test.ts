import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { equivalentInputs, evidenceItemsFor } from "@/newquip/pricing/estimator/__tests__/helpers";
import { costInputHash, micro, rateInputHash, submissionFrom, type PricingSubmission } from "@/newquip/pricing/estimator";
import { createQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "../quote-store";
import { applyPricingChange, attestRates, loadPricingWorkspace, recordManualEvidence, verifyCosts, type PricingActor } from "../pricing-service";
import { listPricingRevisions } from "../pricing-store";

// NQ-008B P2-E, store level (FakeDb emulating 0123 and 0126): independent forward-cover rate attestation and pricing evidence for SKU-less manual items. Every write is to a NewQuip
// table through the same atomic revision function as every other pricing change; nothing talks to Cin7 or Xero.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member"), admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const actor = (email: string, roles: Array<"rep" | "estimator" | "manager">, over: Partial<PricingActor> = {}): PricingActor => ({ orgId: ORG, userId: `u-${email}`, email, roles: new Set(roles), canSeeCost: true, ...over });
const estimator = actor("est@nq", ["rep", "estimator"]);
const manager1 = actor("mgr1@nq", ["rep", "estimator", "manager"]);
const manager2 = actor("mgr2@nq", ["rep", "estimator", "manager"]);
let db: FakeDb;
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);
const loaded = async (id: string) => (await loadQuote(db as never, ORG, id))!;
const cents = (d: QuoteDraft) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const FC = () => ({ rateMicro: micro("20"), coverDays: 90, reference: "FEC-1001", validFrom: day(-1), validUntil: day(60), reason: "90-day forward contract" });
const sub = (over: (s: PricingSubmission) => void = () => undefined): PricingSubmission => { const s = structuredClone(submissionFrom(equivalentInputs({}, "unverified"))); s.forwardCover = { EUR: FC() }; over(s); return s; };

async function inReview(draft: QuoteDraft = readyDraft()): Promise<{ id: string }> {
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, draft);
  await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: cents(draft), confirmedBy: "Farmer Joe" });
  return { id };
}
const rateItems = async (id: string) => { const f = (await loaded(id)).draft.estimator.pricing!.forwardCover.EUR!; return [{ currency: "EUR", rateHash: rateInputHash("EUR", f) }]; };
const attest = async (id: string, a: PricingActor = manager1, evidence = "FEC-1001 bank confirmation") => attestRates(db as never, a, id, await rateItems(id), evidence);

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; seedGoldenCatalogue(db as never, ORG); });

describe("forward-cover rate attestation, end to end", () => {
  it("is one attributed immutable revision; no price moves; the Rep's confirmation stays; the Estimator sign-off is withdrawn; the atomic function is the only writer", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative supplier pricing with a forward contract");
    const before = await loaded(id); const total = cents(before.draft);
    const writesBefore = db.writes.length;
    expect(await attest(id)).toMatchObject({ ok: true, report: { seq: 2, attested: 1 } });
    const q = await loaded(id);
    expect(cents(q.draft)).toBe(total);
    expect(q).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: before.customer_confirmed_cents, estimator_signoff_hash: null });
    expect(q.draft.estimator.pricing!.pricingDate).toBe(before.draft.estimator.pricing!.pricingDate);
    expect(q.draft.estimator.pricing!.forwardCover.EUR!.review).toMatchObject({ by: "mgr1@nq", evidence: "FEC-1001 bank confirmation" });
    const revs = await listPricingRevisions(db as never, ORG, id);
    expect(revs.map((r) => [r.seq, r.changedBy])).toEqual([[1, "est@nq"], [2, "mgr1@nq"]]);
    expect(revs[1].reason).toBe("Independent forward-cover rate attestation: FEC-1001 bank confirmation");
    expect(revs[1].changes.some((c) => c.path === "forwardCover.EUR.review.by" && c.new === "mgr1@nq")).toBe(true);
    expect(db.writes.slice(writesBefore).some((w) => w.table === "newquip_pricing_revisions" && w.op === "insert")).toBe(true);
  });
  it("the person who entered the rate cannot attest it (even holding the role), an Estimator-only reviewer cannot, and a reviewer who then EDITS the rate cannot attest their own edit", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, actor("est@nq", ["rep", "estimator"]), id, sub(), "Indicative pricing");
    expect(await attest(id, actor("est@nq", ["rep", "estimator", "manager"]))).toMatchObject({ ok: false, errors: [expect.stringMatching(/you entered or last changed this rate/)] });
    expect(await attest(id, actor("other.est@nq", ["rep", "estimator"]))).toMatchObject({ ok: false });
    expect(await attest(id, actor("mgr1@nq", ["manager"], { canSeeCost: false }))).toMatchObject({ ok: false });
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(1);
    const edit = submissionFrom((await loaded(id)).draft.estimator.pricing!); edit.forwardCover.EUR = { ...edit.forwardCover.EUR, rateMicro: micro("20.5") };
    expect(await applyPricingChange(db as never, manager1, id, edit, "Corrected the contract rate")).toMatchObject({ ok: true });
    expect(await attest(id, manager1)).toMatchObject({ ok: false, errors: [expect.stringMatching(/you entered or last changed this rate/)] });
    expect(await attest(id, manager2)).toMatchObject({ ok: true });
  });
  it("any later change to the rate drops the attestation (the review covered a different rate), and re-saving it unchanged keeps it", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    await attest(id);
    const keep = submissionFrom((await loaded(id)).draft.estimator.pricing!); keep.projectMarkup = { markupBps: 2500, reason: "markup tweak" };
    expect(await applyPricingChange(db as never, estimator, id, keep, "Markup only")).toMatchObject({ ok: true });
    expect((await loaded(id)).draft.estimator.pricing!.forwardCover.EUR!.review?.by).toBe("mgr1@nq");
    const change = submissionFrom((await loaded(id)).draft.estimator.pricing!); change.forwardCover.EUR = { ...change.forwardCover.EUR, reference: "FEC-9999" };
    expect(await applyPricingChange(db as never, estimator, id, change, "New contract reference")).toMatchObject({ ok: true });
    expect((await loaded(id)).draft.estimator.pricing!.forwardCover.EUR!.review).toBeUndefined();
  });
  it("two reviewers attesting at once: exactly one revision is recorded, the other is told to refresh", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    const items = await rateItems(id);
    const [a, b] = await Promise.all([attestRates(db as never, manager1, id, items, "FEC-1001 a"), attestRates(db as never, manager2, id, items, "FEC-1001 b")]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect(a.ok ? b : a).toMatchObject({ ok: false, errors: [expect.stringMatching(/changed while you were editing/)] });
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(2);
  });
  it("a reviewer who opened the rate BEFORE it changed can never attest the changed rate", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    const seen = await rateItems(id);
    const edit = submissionFrom((await loaded(id)).draft.estimator.pricing!); edit.forwardCover.EUR = { ...edit.forwardCover.EUR, rateMicro: micro("21") };
    await applyPricingChange(db as never, estimator, id, edit, "Changed the rate");
    expect(await attestRates(db as never, manager1, id, seen, "FEC-1001")).toMatchObject({ ok: false, errors: [expect.stringMatching(/EUR: the rate changed after you opened it/)] });
  });
  it("the migration absent: nothing is written and the caller is told why", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    const items = await rateItems(id);
    db.pricingApplied = false;
    expect(await attestRates(db as never, manager1, id, items, "FEC-1001")).toMatchObject({ ok: false, errors: [expect.stringMatching(/migration pending/)] });
    expect((await loaded(id)).draft.estimator.pricing!.forwardCover.EUR!.review).toBeUndefined();
  });
  it("the workspace tells each viewer which rates THEY may attest (never ones they entered), shows the state, and an Estimator-only viewer none", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    expect((await loadPricingWorkspace(db as never, estimator, id)).rateAttestation).toMatchObject({ canReview: false, attestableCurrencies: [] });
    const asMgr = await loadPricingWorkspace(db as never, manager1, id);
    expect(asMgr.rateAttestation).toMatchObject({ canReview: true, reviewerRoles: ["manager"], attestableCurrencies: ["EUR"] });
    expect(asMgr.view.currencies.find((c) => c.currency === "EUR")!.forwardCover).toMatchObject({ state: "unattested", review: null });
    expect((await loadPricingWorkspace(db as never, actor("est@nq", ["rep", "estimator", "manager"]), id)).rateAttestation).toMatchObject({ canReview: true, attestableCurrencies: [] });
    await attest(id);
    expect((await loadPricingWorkspace(db as never, manager2, id)).view.currencies.find((c) => c.currency === "EUR")!.forwardCover).toMatchObject({ state: "attested", review: { by: "mgr1@nq" } });
  });
});

describe("pricing evidence for SKU-less manual items, end to end", () => {
  it("one attributed immutable revision; no price moves; stored with who/when and a SERVER-computed hash; sign-off is withdrawn", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    const total = cents((await loaded(id)).draft);
    const r = await recordManualEvidence(db as never, estimator, id, [{ itemKey: "led_light", note: "Basis: installer quote Q-7", reference: "Q-7" }]);
    expect(r).toMatchObject({ ok: true, report: { seq: 2, recorded: 1 } });
    const q = await loaded(id);
    expect(cents(q.draft)).toBe(total);
    expect(q.draft.estimator.pricing!.manualEvidence!.led_light).toMatchObject({ note: "Basis: installer quote Q-7", reference: "Q-7", by: "est@nq" });
    expect(q.draft.estimator.pricing!.manualEvidence!.led_light!.priceHash).toMatch(/^[0-9a-f]{64}$/);
    const revs = await listPricingRevisions(db as never, ORG, id);
    expect(revs[1]).toMatchObject({ seq: 2, kind: "CHANGED", changedBy: "est@nq" });
    expect(revs[1].changes.some((c) => c.path === "manualEvidence.led_light.note")).toBe(true);
  });
  it("a Rep, a role without cost visibility, an unknown or reserved key, a short note: all refused, nothing written", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    const note = "Basis: installer quote Q-7";
    expect(await recordManualEvidence(db as never, actor("rep@nq", ["rep"], { canSeeCost: false }), id, [{ itemKey: "led_light", note }])).toMatchObject({ ok: false });
    expect(await recordManualEvidence(db as never, actor("est@nq", ["rep", "estimator"], { canSeeCost: false }), id, [{ itemKey: "led_light", note }])).toMatchObject({ ok: false });
    expect(await recordManualEvidence(db as never, estimator, id, [{ itemKey: "__proto__", note }])).toMatchObject({ ok: false });
    expect(await recordManualEvidence(db as never, estimator, id, [{ itemKey: "led_light", note: "short" }])).toMatchObject({ ok: false });
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(1);
  });
  it("two concurrent recordings: exactly one revision wins; model off: refused (legacy behaviour untouched)", async () => {
    const { id } = await inReview();
    expect(await recordManualEvidence(db as never, estimator, id, [{ itemKey: "led_light", note: "Basis: installer quote Q-7" }])).toMatchObject({ ok: false, errors: [expect.stringMatching(/not switched on/)] });
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    const items = [{ itemKey: "led_light", note: "Basis: installer quote Q-7" }];
    const [a, b] = await Promise.all([recordManualEvidence(db as never, estimator, id, items), recordManualEvidence(db as never, estimator, id, items)]);
    expect([a.ok, b.ok].filter(Boolean).length).toBe(1);
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(2);
  });
  it("a price change AFTER the evidence makes it outdated in the workspace; a pricing save carries the stored evidence over", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    await recordManualEvidence(db as never, estimator, id, evidenceItemsFor((await loaded(id)).draft));
    const ws1 = await loadPricingWorkspace(db as never, manager1, id);
    expect(ws1.view.manualEvidence.every((m) => m.state === "recorded")).toBe(true);
    const keep = submissionFrom((await loaded(id)).draft.estimator.pricing!); keep.projectMarkup = { markupBps: 2500, reason: "markup" };
    await applyPricingChange(db as never, estimator, id, keep, "Markup only");
    expect(Object.keys((await loaded(id)).draft.estimator.pricing!.manualEvidence!).sort()).toEqual(ws1.view.manualEvidence.map((m) => m.itemKey).sort());
    // the Estimator moves the LED price through the draft: the evidence no longer covers it
    const d = (await loaded(id)).draft; d.estimator.priceResolutions = { ...d.estimator.priceResolutions, led_light: { unitPriceExVat: 1000, reason: "price moved" } };
    await db.from("newquip_quotes").update({ draft: d }).eq("id", id);
    expect((await loadPricingWorkspace(db as never, manager1, id)).view.manualEvidence.find((m) => m.itemKey === "led_light")).toMatchObject({ state: "outdated" });
  });
});

describe("full workflow: sign-off and approval need verified costs, attested rates AND recorded evidence; the Manager sees the evidence", () => {
  it("blocked on each in turn (none waivable), then signed off and approved; the sealed baseline carries who attested and who recorded what", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator, id, sub(), "Indicative pricing");
    const costs = async () => { const p = (await loaded(id)).draft.estimator.pricing!; return verifyCosts(db as never, manager1, id, Object.keys(p.skus).map((sku) => ({ sku, costHash: costInputHash(p.skus[sku]!) })), "Supplier quote SQ-1"); };
    expect(await costs()).toMatchObject({ ok: true });
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/forward-cover rate: the forward-cover rate has not been independently attested/);
    expect(await attest(id)).toMatchObject({ ok: true });
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/no pricing evidence has been recorded/);
    expect(await recordManualEvidence(db as never, estimator, id, evidenceItemsFor((await loaded(id)).draft))).toMatchObject({ ok: true });
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    await managerApprove(db as never, ORG, admin, "mgr2@nq", id, ctx);
    const p = (await loaded(id)).accepted_baseline!.estimator.pricing!;
    expect(p.forwardCover.EUR!.review).toMatchObject({ by: "mgr1@nq", evidence: "FEC-1001 bank confirmation" });
    expect(Object.values(p.manualEvidence!).every((e) => e!.by === "est@nq" && e!.note.length >= 10)).toBe(true);
  });
});
