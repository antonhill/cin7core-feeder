import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { rolesFor } from "@/newquip/quote/roles";
import { cost7 } from "@/newquip/pricing/model";
import type { PricingSubmission } from "@/newquip/pricing/estimator/apply";
import { equivalentInputs } from "@/newquip/pricing/estimator/__tests__/helpers";
import { createQuote, loadQuote, saveDraft, sendToEstimator } from "../quote-store";
import { applyPricingChange, loadPricingWorkspace, type PricingActor } from "../pricing-service";
import { listPricingRevisions } from "../pricing-store";

// PARITY PIN: the FakeDb emulation of newquip_apply_pricing_revision (migration 0126) must refuse exactly what the real function refuses. The REAL function is exercised against a clean database by
// supabase/tests/0126_newquip_apply_pricing_revision_contract.test.sql (CI job "Clean migration bootstrap + RLS/security test matrix"); each case below mirrors one case there, with the same message.
// Then the full merge -> persist contract is run on top of the pinned emulation.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
const A: PricingActor = { orgId: ORG, userId: "u-a", email: "a@nq", roles: new Set(["rep", "estimator"]), canSeeCost: true };
const B: PricingActor = { orgId: ORG, userId: "u-b", email: "b@nq", roles: new Set(["rep", "estimator"]), canSeeCost: true };
let db: FakeDb;
const rpc = (a: Record<string, unknown>) => db.rpc("newquip_apply_pricing_revision", a) as unknown as Promise<{ data: unknown; error: { message: string } | null }>;
type QRow = { id: string; draft: { estimator: object } & Record<string, unknown>; draft_hash: string; state: string; estimator_signoff_hash: unknown };
const row = (id: string) => (db.rows("newquip_quotes") as unknown as QRow[]).find((r) => r.id === id)!;
const price = (cost: number, by = "a@x") => ({ skus: { X: { nativeUnitCostE7: cost, currency: "EUR", by, at: "t" } } });
const call = (id: string, seq: number, hash: string, newHash: string, prev: unknown, next: unknown, by = "a@x", draftExtra: Record<string, unknown> = {}) => rpc({
  p_org: ORG, p_quote: id, p_expected_seq: seq, p_expected_draft_hash: hash, p_new_draft: { ...(row(id).draft as object), estimator: { ...(row(id).draft.estimator as object), pricing: next }, ...draftExtra }, p_new_draft_hash: newHash,
  p_kind: prev ? "CHANGED" : "ENABLED", p_reason: "Contract test", p_rule_version: "legacy-poc-v1", p_previous_pricing: prev, p_new_pricing: next, p_changes: [], p_new_pricing_hash: "b".repeat(64), p_changed_by: by,
});

async function inReview(): Promise<string> {
  const d = readyDraft();
  const { id } = await createQuote(db as never, ORG, "rep@nq");
  await saveDraft(db as never, ORG, member, id, d);
  await sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100), confirmedBy: "Farmer Joe" });
  return id;
}
beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; db.pricingApplied = true; seedGoldenCatalogue(db as never, ORG); });

describe("FakeDb newquip_apply_pricing_revision == the real function's contract (mirrors supabase/tests/0126_newquip_apply_pricing_revision_contract.test.sql)", () => {
  it("compare-and-set: a stale draft hash and a stale sequence are each refused with pricing_conflict, change nothing; a save on the CURRENT hash and seq succeeds atomically (revision + draft + sign-off withdrawal)", async () => {
    const id = await inReview();
    row(id).estimator_signoff_hash = row(id).draft_hash; // a recorded sign-off
    const h0 = row(id).draft_hash as string;
    expect((await call(id, 0, h0, "k1", null, price(100, "b@x"), "b@x")).error).toBeNull();
    expect(row(id).draft_hash).toBe("k1");
    expect(row(id).estimator_signoff_hash).toBeNull();
    expect(db.rows("newquip_pricing_revisions")).toHaveLength(1);
    const before = JSON.stringify(row(id));
    expect((await call(id, 0, h0, "k2", null, price(110))).error?.message).toMatch(/^pricing_conflict/); // the racing second save, old hash AND seq
    expect((await call(id, 1, h0, "k2", price(100, "b@x"), price(110))).error?.message).toMatch(/pricing_conflict: the quotation changed while the pricing was being edited/); // stale hash alone
    expect((await call(id, 0, "k1", "k2", price(100, "b@x"), price(110))).error?.message).toMatch(/pricing_conflict: the pricing changed while it was being edited/); // stale seq alone
    expect(JSON.stringify(row(id))).toBe(before);
    expect(db.rows("newquip_pricing_revisions")).toHaveLength(1);
    expect((await call(id, 1, "k1", "k2", price(100, "b@x"), price(110))).error).toBeNull();
    expect(db.rows("newquip_pricing_revisions").map((r) => (r as { seq: number }).seq)).toEqual([1, 2]);
  });
  it("only estimator.pricing may differ; the recorded previous / new pricing must be the stored / written ones", async () => {
    const id = await inReview(); const h0 = row(id).draft_hash as string;
    expect((await call(id, 0, h0, "k1", null, price(100), "a@x", { customerName: "HIJACKED" })).error?.message).toMatch(/may change only estimator.pricing/);
    expect((await call(id, 0, h0, "k1", price(1), price(100))).error?.message).toMatch(/previous pricing is not the stored pricing/);
    expect((await rpc({ ...(await captured(id, h0)), p_new_pricing: price(101) })).error?.message).toMatch(/new pricing is not the pricing written/);
    expect(db.rows("newquip_pricing_revisions")).toHaveLength(0);
  });
  it("review structure: reviewer == entrant, reviewer != the person recording, a review on a changed cost, and a changed cost still carrying a review are all refused; an independent review of the unchanged entry is accepted", async () => {
    const id = await inReview();
    await call(id, 0, row(id).draft_hash, "k1", null, price(110, "a@x"), "a@x");
    const rv = (reviewBy: string, cost = 110, extra: Record<string, unknown> = {}) => ({ skus: { X: { nativeUnitCostE7: cost, currency: "EUR", by: "a@x", at: "t", review: { by: reviewBy, at: "t", evidence: "e", inputHash: "h" }, ...extra } } });
    expect((await call(id, 1, "k1", "k2", price(110, "a@x"), rv("a@x"), "a@x")).error?.message).toMatch(/cannot be verified by the person who entered it/);
    expect((await call(id, 1, "k1", "k2", price(110, "a@x"), rv("m@x"), "someone.else@x")).error?.message).toMatch(/must be recorded by the reviewer/);
    expect((await call(id, 1, "k1", "k2", price(110, "a@x"), rv("m@x", 111), "m@x")).error?.message).toMatch(/changed cost cannot carry a review/);
    expect((await call(id, 1, "k1", "k2", price(110, "a@x"), rv("m@x"), "m@x")).error).toBeNull();
    const reviewed = rv("m@x");
    expect((await call(id, 2, "k2", "k3", reviewed, { skus: { X: { ...reviewed.skus.X, currency: "USD" } } }, "a@x")).error?.message).toMatch(/changed cost cannot carry a review/);
    expect(db.rows("newquip_pricing_revisions")).toHaveLength(2);
  });
  it("an approved / final quotation is refused", async () => {
    const id = await inReview(); const h0 = row(id).draft_hash as string;
    row(id).state = "MANAGER_APPROVED_FINAL";
    expect((await call(id, 0, h0, "k1", null, price(100))).error?.message).toMatch(/pricing_conflict: the quotation can no longer be edited/);
    expect(db.rows("newquip_pricing_revisions")).toHaveLength(0);
  });
  async function captured(id: string, hash: string) {
    const next = price(100);
    return { p_org: ORG, p_quote: id, p_expected_seq: 0, p_expected_draft_hash: hash, p_new_draft: { ...(row(id).draft as object), estimator: { ...(row(id).draft.estimator as object), pricing: next } }, p_new_draft_hash: "k1", p_kind: "ENABLED", p_reason: "Contract test", p_rule_version: "legacy-poc-v1", p_previous_pricing: null, p_new_pricing: next, p_changes: [], p_new_pricing_hash: "b".repeat(64), p_changed_by: "a@x" };
  }
});

describe("full merge -> persist on the parity-pinned emulation", () => {
  const submissionOf = (): PricingSubmission => {
    const s = structuredClone(equivalentInputs({}, "unverified"));
    return { ruleVersionId: s.ruleVersionId, skus: Object.fromEntries(Object.entries(s.skus).map(([k, v]) => { const { by: _b, at: _a, ...rest } = v!; void _b; void _a; return [k, rest as never]; })), fxQuotes: s.fxQuotes as never, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null };
  };
  const load = async (id: string, who: PricingActor) => { const c = (await loadPricingWorkspace(db as never, who, id)).current!; return { base: structuredClone(c), draft: structuredClone(c) }; };
  it("a merged save carries the CURRENT hash and seq (the RPC accepts it); a concurrent change between the merge read and the write is still refused by the compare-and-set; nothing hybrid is ever written", async () => {
    const id = await inReview();
    const [X, Y] = Object.keys(submissionOf().skus);
    await applyPricingChange(db as never, A, id, submissionOf(), "Initial supplier pricing", null);
    const a = await load(id, A), b = await load(id, B);
    b.draft.skus[X].currency = b.draft.skus[X].currency === "EUR" ? "USD" : "EUR"; // B changes only the currency of X and saves first
    expect((await applyPricingChange(db as never, B, id, b.draft, "B currency", b.base)).ok).toBe(true);
    a.draft.skus[X].nativeUnitCostE7 = cost7("110"); // A edits only the cost of X: the coupled unit CONFLICTS (no EUR 110 hybrid), and nothing is written
    const before = JSON.stringify((await loadQuote(db as never, ORG, id))!.draft);
    const refused = await applyPricingChange(db as never, A, id, a.draft, "A cost", a.base);
    expect(refused).toMatchObject({ ok: false, conflicts: [expect.objectContaining({ key: `sku:${X}` })] });
    expect(JSON.stringify((await loadQuote(db as never, ORG, id))!.draft)).toBe(before);
    // A's edit on a DIFFERENT SKU merges and is accepted by the RPC on the fresh hash/seq
    const a2 = await load(id, A); a2.draft.skus[Y].nativeUnitCostE7 = cost7("3.1234567");
    const b2 = await load(id, B); b2.draft.skus[X].supplierName = "B2";
    expect((await applyPricingChange(db as never, B, id, b2.draft, "B name", b2.base)).ok).toBe(true);
    expect((await applyPricingChange(db as never, A, id, a2.draft, "A Y", a2.base)).ok).toBe(true);
    const p = (await loadQuote(db as never, ORG, id))!.draft.estimator.pricing!;
    expect(p.skus[Y]!.nativeUnitCostE7).toBe(31_234_567);
    expect(p.skus[X]!.supplierName).toBe("B2");
    // a concurrent change landing between the merge read and the RPC is refused by the compare-and-set, not merged blindly
    const a3 = await load(id, A); a3.draft.skus[Y].nativeUnitCostE7 = cost7("4");
    const realRpc = db.rpc.bind(db);
    (db as unknown as { rpc: unknown }).rpc = (fn: string, args: Record<string, unknown>) => { if (fn === "newquip_apply_pricing_revision") (db.rows("newquip_quotes")[0] as Record<string, unknown>).draft_hash = "changed-elsewhere"; return realRpc(fn, args); };
    expect(await applyPricingChange(db as never, A, id, a3.draft, "A racing", a3.base)).toMatchObject({ ok: false, errors: [expect.stringMatching(/changed while you were editing/)] });
    expect((await listPricingRevisions(db as never, ORG, id)).length).toBe(4);
  });
});
