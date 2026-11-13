import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { redactInternalFinancials } from "@/newquip/quote/margin";
import { micro } from "@/newquip/pricing/model";
import { equivalentInputs, withPricing, AT, EST } from "@/newquip/pricing/estimator/__tests__/helpers";
import { createQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "../quote-store";
import { allIndicativeSnapshots } from "../indicative-store";
import { reconcileConfirmationAmount } from "../confirmation-reconcile";

// NQ-008B Phase 2, store level (FakeDb): the Rep -> Estimator -> Manager workflow with the OPT-IN supplier-pricing model. Nothing is mocked except the audit log and
// server-only, so the real hand-off (with its immutable NQ-008A snapshot), sign-off, approval, confirmation withdrawal and sealed baseline all run.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member"), admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const BY = { email: "est@nq", role: "estimator" as const };
let db: FakeDb;
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);
const cents = (d: QuoteDraft) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; seedGoldenCatalogue(db as never, ORG); }); // 0123 as applied on the shared database
async function stored(d: QuoteDraft): Promise<string> { const { id } = await createQuote(db as never, ORG, "rep@nq"); await saveDraft(db as never, ORG, member, id, d); return id; }
const handoff = (id: string, amount: number) => sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: amount, confirmedBy: "Farmer Joe" });

describe("1. a legacy quotation is untouched by the new code path", () => {
  it("runs Rep -> Estimator -> Manager exactly as before, priced by the POC source", async () => {
    const d = readyDraft();
    const id = await stored(d);
    await handoff(id, cents(d));
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    const r = await managerApprove(db as never, ORG, admin, "mgr@nq", id, ctx);
    expect(r.contractCents).toBe(cents(d));
    const q = (await loadQuote(db as never, ORG, id))!;
    expect(q.accepted_baseline!.estimator.pricing).toBeUndefined();
  });
});

describe("11. the full Rep -> Estimator -> Manager workflow with Estimator supplier pricing", () => {
  it("INDICATIVE: unverified supplier costs support the Rep's handoff and a labelled indicative price, but block sign-off and approval, with the incomplete-costing exception in place", async () => {
    const d = withPricing(equivalentInputs({}, "unverified"));
    expect(d.estimator.costBasis?.incompleteAccepted).toBeDefined(); // the exception IS present: it must not waive an unverified price
    const id = await stored(d);
    await handoff(id, cents(d)); // indicative is allowed
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("ESTIMATOR_REVIEW");
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/Costing is incomplete.*not verified.*indicative only/);
    expect(await err(managerApprove(db as never, ORG, admin, "mgr@nq", id, ctx))).toMatch(/Costing is incomplete|has not signed off/);
  });
  it("MISSING cost: a SKU with no supplier cost leaves the quotation BLOCKED, never priced at zero, and nothing can be signed off", async () => {
    const p = equivalentInputs(); delete p.skus.ERT053;
    const d = withPricing(p);
    expect(evaluateDraft(d, ctx).readiness.state).toBe("BLOCKED");
    const id = await stored(d);
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/not possible from Rep draft|BLOCKED|price/i);
  });
  it("VERIFIED: verified costs -> sign-off -> Manager approval, a sealed baseline carrying the pricing (internal), redacted for a Rep", async () => {
    const d = withPricing(equivalentInputs({}, "verified"));
    const id = await stored(d);
    const total = cents(d);
    await handoff(id, total);
    await estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
    const r = await managerApprove(db as never, ORG, admin, "mgr@nq", id, ctx);
    expect(r.contractCents).toBe(total);
    const q = (await loadQuote(db as never, ORG, id))!;
    expect(q.accepted_baseline!.estimator.pricing!.revision).toBe(1);
    const rep = redactInternalFinancials(q as never, false) as unknown as QuoteDraftHolder;
    expect(rep.draft.estimator.pricing).toBeUndefined();
    expect(rep.accepted_baseline!.estimator!.pricing).toBeUndefined();
    expect(JSON.stringify(rep)).not.toMatch(/nativeUnitCost|Fixture supplier sheet|forwardCover/);
  });
});

type QuoteDraftHolder = { draft: QuoteDraft; accepted_baseline: { estimator?: { pricing?: unknown } } | null };

describe("8. an Estimator price change after handoff follows the existing Rep reconfirmation workflow, and the Rep's snapshot is preserved", () => {
  it("a forward-cover change moves the total: the confirmation is withdrawn, the quotation returns to the Rep (revision 2), and snapshot 1 is byte-identical", async () => {
    const d = withPricing(equivalentInputs({}, "verified"));
    const id = await stored(d);
    const before = cents(d);
    await handoff(id, before);
    const snap1 = (await allIndicativeSnapshots(db as never, ORG, id))[0];
    const snap1Json = JSON.stringify(snap1);
    expect(snap1.snapshot.internal.priceSource.id).toBe("estimator_supplier_pricing");

    // the Estimator records a 90-day forward-cover rate (what the pricing action will do in the next PR): the draft changes, the total changes
    const cheaper = withPricing(equivalentInputs({ revision: 2, forwardCover: { EUR: { rateMicro: micro("19"), coverDays: 90, reason: "90-day forward contract", by: EST, at: AT } } }, "verified"));
    await saveDraft(db as never, ORG, member, id, cheaper);
    const after = cents(cheaper);
    expect(after).toBeLessThan(before);
    const eff = await reconcileConfirmationAmount(db as never, { orgId: ORG, userId: "u", email: "est@nq" }, id, ctx, BY);
    expect(eff).toMatchObject({ confirmationCleared: true, returnedToRep: true, previousCents: before, newCents: after });
    const q = (await loadQuote(db as never, ORG, id))!;
    expect(q).toMatchObject({ state: "REP_DRAFT", revision: 2, customer_confirmed_cents: null });
    expect(await err(estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx))).toMatch(/not possible from Rep draft/);

    // the original snapshot is unchanged (append-only); the Rep reconfirms the NEW amount and a second snapshot is captured
    expect(JSON.stringify((await allIndicativeSnapshots(db as never, ORG, id))[0])).toBe(snap1Json);
    await handoff(id, after);
    const all = await allIndicativeSnapshots(db as never, ORG, id);
    expect(all.map((s) => s.seq)).toEqual([1, 2]);
    expect(JSON.stringify(all[0])).toBe(snap1Json);
    expect(all[1].snapshot.customerSafe.subtotalCents).toBe(after);
  });
  it("a change that does NOT move the customer total (a cost-side-only change) does not withdraw the confirmation", async () => {
    const d = withPricing(equivalentInputs({}, "verified"));
    const id = await stored(d);
    await handoff(id, cents(d));
    const same = withPricing(equivalentInputs({ revision: 2, targetAdjustment: { targetTotalCents: 5_000_000, reason: "internal only", by: EST, at: AT } }, "verified"));
    await saveDraft(db as never, ORG, member, id, same);
    expect(cents(same)).toBe(cents(d)); // an internal target adjustment is not applied
    expect(await reconcileConfirmationAmount(db as never, { orgId: ORG, userId: "u", email: "est@nq" }, id, ctx, BY)).toBeNull();
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("ESTIMATOR_REVIEW");
  });
});
