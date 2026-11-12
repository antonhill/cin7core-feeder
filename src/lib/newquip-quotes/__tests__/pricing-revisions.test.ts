import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { micro } from "@/newquip/pricing/model";
import type { PricingSubmission } from "@/newquip/pricing/estimator/apply";
import { equivalentInputs } from "@/newquip/pricing/estimator/__tests__/helpers";
import { createQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "../quote-store";
import { allIndicativeSnapshots } from "../indicative-store";
import { applyPricingChange, loadPricingWorkspace, type PricingActor } from "../pricing-service";
import { listPricingRevisions } from "../pricing-store";

// NQ-008B Phase 2 persistence + workflow (FakeDb emulating migration 0126 and 0123): the immutable revision, the Rep reconfirmation, role gates, confidentiality and the
// full Rep -> Estimator -> Manager flow. Cin7 is never touched: every write is to a NewQuip table.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member"), admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const estimator = (over: Partial<PricingActor> = {}): PricingActor => ({ orgId: ORG, userId: "u-est", email: "est@nq", roles: new Set(["rep", "estimator"]), canSeeCost: true, ...over });
const rep: PricingActor = { orgId: ORG, userId: "u-rep", email: "rep@nq", roles: new Set(["rep"]), canSeeCost: false };
let db: FakeDb;
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);

const submissionOf = (over: Partial<PricingSubmission> = {}, verified: "verified" | "unverified" = "verified"): PricingSubmission => {
  const s = structuredClone(equivalentInputs({}, verified));
  return { ruleVersionId: s.ruleVersionId, skus: Object.fromEntries(Object.entries(s.skus).map(([k, v]) => { const { by: _b, at: _a, ...rest } = v!; void _b; void _a; return [k, rest as never]; })), fxQuotes: s.fxQuotes as never, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null, ...over };
};
const cents = (d: ReturnType<typeof readyDraft>) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);
async function inReview(): Promise<{ id: string; total: number }> {
  const d = readyDraft();
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  const total = cents(d);
  await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: total, confirmedBy: "Farmer Joe" });
  return { id, total };
}
const loaded = async (id: string) => (await loadQuote(db as never, ORG, id))!;

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; seedGoldenCatalogue(db as never, ORG); });

describe("7. immutable revision history", () => {
  it("enabling supplier pricing records revision 1 (who, when, why, rule version, previous null -> new) and writes only NewQuip tables", async () => {
    const { id, total } = await inReview();
    const r = await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing from the quote sheet");
    expect(r).toMatchObject({ ok: true, report: { seq: 1, kind: "ENABLED" } });
    const [rev] = await listPricingRevisions(db as never, ORG, id);
    expect(rev).toMatchObject({ seq: 1, kind: "ENABLED", ruleVersion: "legacy-poc-v1", reason: "Initial supplier pricing from the quote sheet", changedBy: "est@nq", quoteRevision: 1 });
    expect(rev.changes.every((c) => c.previous === null && c.new !== null)).toBe(true);
    const q = await loaded(id);
    expect(q.draft.estimator.pricing).toMatchObject({ enabled: true, revision: 1 });
    expect(q.draft_hash).toBe(db.rows("newquip_pricing_revisions")[0].draft_hash_after);
    // equivalent inputs: the customer total did not move, so the Rep's confirmation stands (and the Estimator's sign-off, if any, was withdrawn by the change)
    expect(q).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total });
    // nothing outside NewQuip's own tables was written: no Cin7, Xero or Projects table
    expect([...new Set(db.writes.map((w) => w.table))].every((t) => /^newquip_|^activity_log$/.test(t))).toBe(true);
  });
  it("a second change is revision 2 with previous AND new values; revision 1 is untouched; rows can never be changed through the store (append-only)", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing");
    const first = JSON.stringify((await listPricingRevisions(db as never, ORG, id))[0]);
    const sub = submissionOf({ forwardCover: { EUR: { rateMicro: micro("19"), coverDays: 90, reference: "FEC-9", reason: "90-day forward contract" } } });
    const q1 = await loaded(id);
    sub.skus = Object.fromEntries(Object.entries(q1.draft.estimator.pricing!.skus).map(([k, v]) => { const { by: _b, at: _a, ...rest } = v!; void _b; void _a; return [k, rest as never]; }));
    const r = await applyPricingChange(db as never, estimator({ email: "mgr@nq" }), id, { ...sub, fxQuotes: q1.draft.estimator.pricing!.fxQuotes as never }, "Forward cover booked");
    expect(r).toMatchObject({ ok: true, report: { seq: 2, kind: "CHANGED" } });
    const revs = await listPricingRevisions(db as never, ORG, id);
    expect(revs.map((x) => x.seq)).toEqual([1, 2]);
    expect(JSON.stringify(revs[0])).toBe(first);
    expect(revs[1].changes.find((c) => c.path === "forwardCover.EUR.rateMicro")).toMatchObject({ previous: null, new: 19_000_000 });
    expect(revs[1]).toMatchObject({ changedBy: "mgr@nq", reason: "Forward cover booked" });
  });
  it("a stale submit (double click / concurrent edit) is refused and changes nothing; a missing migration fails closed and writes nothing", async () => {
    const { id } = await inReview();
    const realRpc = db.rpc.bind(db);
    // a concurrent edit lands between the read and the function
    (db as unknown as { rpc: unknown }).rpc = (fn: string, a: Record<string, unknown>) => { if (fn === "newquip_apply_pricing_revision") (db.rows("newquip_quotes")[0] as Record<string, unknown>).draft_hash = "changed-elsewhere"; return realRpc(fn, a); };
    expect(await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing")).toMatchObject({ ok: false, errors: [expect.stringMatching(/changed while you were editing/)] });
    expect(db.rows("newquip_pricing_revisions")).toHaveLength(0);
    (db as unknown as { rpc: unknown }).rpc = realRpc;
    (db.rows("newquip_quotes")[0] as Record<string, unknown>).draft_hash = (await loaded(id)).draft_hash; // (unchanged value; the earlier override only simulated the race)
    db.pricingApplied = false;
    const before = JSON.stringify((await loaded(id)).draft);
    expect(await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing")).toMatchObject({ ok: false, errors: [expect.stringMatching(/migration pending/)] });
    expect(JSON.stringify((await loaded(id)).draft)).toBe(before);
  });
  it("an approved quotation can no longer be repriced", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing");
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    await managerApprove(db as never, ORG, admin, "mgr@nq", id, ctx);
    expect(await applyPricingChange(db as never, estimator(), id, submissionOf({ projectMarkup: { markupBps: 3000, reason: "late" } }), "Too late")).toMatchObject({ ok: false, errors: [expect.stringMatching(/approved/)] });
  });
});

describe("8. an Estimator price change follows the Rep reconfirmation workflow; the Rep's snapshot is preserved", () => {
  it("a forward-cover change that moves the total withdraws the confirmation and returns the quotation to the Rep; snapshot 1 is byte-identical; the Rep reconfirms and snapshot 2 is taken", async () => {
    const { id, total } = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing");
    const snap1 = JSON.stringify((await allIndicativeSnapshots(db as never, ORG, id))[0]);
    const q1 = await loaded(id);
    const sub = submissionOf({ fxQuotes: q1.draft.estimator.pricing!.fxQuotes as never, forwardCover: { EUR: { rateMicro: micro("19"), coverDays: 90, reference: "FEC-9", reason: "90-day forward contract" } } });
    const r = await applyPricingChange(db as never, estimator(), id, sub, "Forward cover booked");
    expect(r.ok && r.report.confirmation).toMatchObject({ confirmationCleared: true, returnedToRep: true, previousCents: total });
    const q = await loaded(id);
    expect(q).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null });
    expect(JSON.stringify((await allIndicativeSnapshots(db as never, ORG, id))[0])).toBe(snap1);
    const newTotal = cents(q.draft);
    expect(newTotal).toBeLessThan(total);
    await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: newTotal, confirmedBy: "Farmer Joe" });
    const all = await allIndicativeSnapshots(db as never, ORG, id);
    expect(all.map((s) => s.seq)).toEqual([1, 2]);
    expect(JSON.stringify(all[0])).toBe(snap1);
  });
  it("an internal target-price adjustment never moves the customer total and so never withdraws the confirmation", async () => {
    const { id, total } = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf(), "Initial supplier pricing");
    const q1 = await loaded(id);
    const r = await applyPricingChange(db as never, estimator(), id, submissionOf({ fxQuotes: q1.draft.estimator.pricing!.fxQuotes as never, targetAdjustment: { targetTotalCents: 5_000_000, reason: "Internal target" } }), "Record the internal target");
    expect(r).toMatchObject({ ok: true, report: { confirmation: null } });
    expect(await loaded(id)).toMatchObject({ state: "ESTIMATOR_REVIEW", customer_confirmed_cents: total });
  });
});

describe("9. role-based confidentiality and authority", () => {
  it("a Rep (or an Estimator without cost visibility) can neither read the workspace nor change anything", async () => {
    const { id } = await inReview();
    expect(await err(loadPricingWorkspace(db as never, rep, id))).toMatch(/internal/);
    expect(await err(loadPricingWorkspace(db as never, estimator({ canSeeCost: false }), id))).toMatch(/internal/);
    for (const a of [rep, estimator({ canSeeCost: false })]) expect(await applyPricingChange(db as never, a, id, submissionOf(), "Trying it anyway")).toMatchObject({ ok: false });
    expect(db.rows("newquip_pricing_revisions")).toHaveLength(0);
    expect((await loaded(id)).draft.estimator.pricing).toBeUndefined();
  });
  it("the workspace shows the SKU breakdown, supplier, currency, cost, source, verification, rate, freight, landed cost, price, margin and markup to an authorised Estimator", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf({}, "unverified"), "Initial supplier pricing");
    const b = await loadPricingWorkspace(db as never, estimator(), id);
    expect(b.view).toMatchObject({ enabled: true, available: true, ruleVersionId: "legacy-poc-v1", revision: 1 });
    expect(b.view.rows.length).toBeGreaterThan(10);
    const row = b.view.rows.find((r) => r.currency === "EUR")!;
    expect(row).toMatchObject({ status: "priced", verification: "unverified", costSource: "Fixture supplier sheet" });
    expect(row.rate).toMatchObject({ kind: "spot" });
    expect(row.unitLandedCostCents).toBeGreaterThan(0);
    expect(row.margin).toMatchObject({ marginPct: expect.any(Number), markupPct: expect.any(Number) });
    expect(b.view.finality.final).toBe(false);
    expect(b.view.attention.join(" ")).toMatch(/not verified/);
    expect(b.view.indicative.originalTotalCents).not.toBeNull();
    expect(b.view.currencies.map((c) => c.currency)).toEqual(["EUR", "USD"]);
    expect(b.revisions).toHaveLength(1);
    expect(b.canEdit).toBe(true);
  });
});

describe("6. incomplete-price safeguards in the workspace", () => {
  it("a SKU the quotation needs but has no supplier cost is shown as NOT PRICED, the total is withheld, and nothing is zero", async () => {
    const { id } = await inReview();
    const sub = submissionOf(); delete sub.skus.ERT053;
    await applyPricingChange(db as never, estimator(), id, sub, "Initial supplier pricing (one SKU still awaited)");
    const b = await loadPricingWorkspace(db as never, estimator(), id);
    const row = b.view.rows.find((r) => r.sku === "ERT053")!;
    expect(row).toMatchObject({ status: "no_input", unitPriceCents: null, lineRevenueCents: null });
    expect(b.view.totals.totalCents).toBeNull();
    expect(b.view.attention.join(" ")).toMatch(/ERT053: no supplier cost entered/);
  });
});

describe("11. the full Rep -> Estimator -> Manager workflow through the pricing action", () => {
  it("indicative handoff -> Estimator enters UNVERIFIED costs (sign-off blocked) -> verifies them (a new revision) -> sign-off -> Manager approval; the baseline carries the pricing", async () => {
    const { id } = await inReview();
    await applyPricingChange(db as never, estimator(), id, submissionOf({}, "unverified"), "Indicative supplier pricing (unverified)");
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/not verified.*indicative only/);
    const q1 = await loaded(id);
    const verified = submissionOf({ fxQuotes: q1.draft.estimator.pricing!.fxQuotes as never }, "verified");
    const r = await applyPricingChange(db as never, estimator(), id, verified, "Verified against the supplier quotes");
    expect(r).toMatchObject({ ok: true, report: { seq: 2, kind: "CHANGED", confirmation: null } });
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    const approved = await managerApprove(db as never, ORG, admin, "mgr@nq", id, ctx);
    expect(approved.contractCents).toBeGreaterThan(0);
    const q = await loaded(id);
    expect(q.state).toBe("MANAGER_APPROVED_FINAL");
    expect(q.accepted_baseline!.estimator.pricing).toMatchObject({ revision: 2 });
    expect((await listPricingRevisions(db as never, ORG, id)).map((x) => x.seq)).toEqual([1, 2]);
  });
});

describe("the Server Actions file follows the project's standing rule", () => {
  it('"use server" file: ONLY async function exports (and erased interfaces) - no exported consts, objects or type re-exports', () => {
    const src = readFileSync(path.resolve(__dirname, "../../../app/newquip-grower/pricing-actions.ts"), "utf8");
    expect(src.trimStart().startsWith('"use server"')).toBe(true);
    const exports = src.split("\n").filter((l) => /^export\s/.test(l));
    expect(exports.length).toBeGreaterThanOrEqual(4);
    for (const l of exports) expect(l, l).toMatch(/^export (async function|interface) /);
    expect(src).not.toMatch(/export type \{|export \{|export default|export const|export let/);
  });
});
