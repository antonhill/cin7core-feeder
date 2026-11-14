import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb } from "@/lib/projects/__tests__/fake-db";
import { seedGoldenCatalogue } from "@/newquip/grower/__tests__/golden-catalogue";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { micro, cost7 } from "@/newquip/pricing/model";
import { equivalentInputs, withPricing, AT, EST, REVIEWER } from "@/newquip/pricing/estimator/__tests__/helpers";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { internalTokenSet } from "../customer-document";
import { costInputHash } from "@/newquip/pricing/estimator/verification";
import { rateInputHash } from "@/newquip/pricing/estimator/attestation";
import type { EstimatorPricing, SkuPricingInput } from "@/newquip/pricing/estimator/types";
import { baselineExceptionOf, costingOf, createQuote, estimatorSignOff, loadQuote, managerApprove, saveDraft, sendToEstimator } from "../quote-store";

// NQ-008B Phase 2 follow-up, store level (FakeDb): the NORMAL path (Rep -> Estimator -> Manager) with supplier pricing and NO incomplete-costing waiver. The sibling file covers the rest of the workflow. Nothing is mocked except the audit log and
// server-only, so the real hand-off (with its immutable NQ-008A snapshot), sign-off, approval, confirmation withdrawal and sealed baseline all run.
vi.mock("server-only", () => ({}));
vi.mock("@/lib/activity-log", () => ({ logActivity: vi.fn(() => Promise.resolve()) }));

const ORG = "org-nq";
const ctx = { priceSource: testPriceSource(), withholdCost: true };
const member = rolesFor("member"), admin = rolesFor("admin");
const repOnly = new Set(["rep"] as const) as ReadonlySet<"rep">;
let db: FakeDb;
const err = async (p: Promise<unknown>): Promise<string> => p.then(() => "", (e: Error) => e.message);
const cents = (d: QuoteDraft) => Math.round(evaluateDraft(d, ctx).budget!.totals.subtotalExTax * 100);

beforeEach(() => { db = new FakeDb(); db.indicativeApplied = true; seedGoldenCatalogue(db as never, ORG); }); // 0123 as applied on the shared database
async function stored(d: QuoteDraft): Promise<string> { const { id } = await createQuote(db as never, ORG, "rep@nq"); await saveDraft(db as never, ORG, member, id, d); return id; }
const handoff = (id: string, amount: number) => sendToEstimator(db as never, ORG, repOnly as never, "rep@nq", id, ctx, { confirmedAmountCents: amount, confirmedBy: "Farmer Joe" });


// The fixture draft ships with an authorised incomplete-costing exception, which the older tests rely on. THESE tests remove it (and there are no captured legacy costs): nothing waives anything.
const noWaiver = (d: QuoteDraft): QuoteDraft => { const c = structuredClone(d); if (c.estimator.costBasis) delete (c.estimator.costBasis as { incompleteAccepted?: unknown }).incompleteAccepted; return c; };
const reviewedEntry = (over: Partial<SkuPricingInput> = {}): SkuPricingInput => {
  const e: SkuPricingInput = { supplierId: "sup-za", supplierName: "Fixture Components (Pty) Ltd", currency: "ZAR", nativeUnitCostE7: cost7("1000"), source: "Fixture supplier sheet", freight: { factorMicro: micro("1"), source: "Fixture" }, by: EST, at: AT, ...over };
  return { ...e, review: { by: REVIEWER, at: AT, evidence: "Supplier quote SQ-FIXTURE", inputHash: costInputHash(e) } };
};
/** The mapped component SKUs of the Estimator-priced packages (M75, penning, LED) are physical SKUs of the scope too: their costs are recorded and independently verified like any other. */
const COMPONENTS = ["FIXTURE-M75", "FIXTURE-PENNING", "FIXTURE-LED"] as const;
const completePricing = (over: Partial<EstimatorPricing> = {}): EstimatorPricing => {
  const p = equivalentInputs(over, "verified");
  for (const k of COMPONENTS) p.skus[k] = reviewedEntry();
  return p;
};
const normal = (over: Partial<EstimatorPricing> = {}): QuoteDraft => noWaiver(withPricing(completePricing(over)));
const approve = (id: string) => managerApprove(db as never, ORG, admin, "mgr@nq", id, ctx);
const signOff = (id: string) => estimatorSignOff(db as never, ORG, member, "est@nq", id, ctx);
const SIGNOFF_BLOCKED = /Costing is incomplete/;
/** Every reason costing is incomplete (sign-off and approval show the first one; the full list is what the workspace shows). */
const reasonsOf = async (d: QuoteDraft): Promise<string> => { const c = await costingOf(db as never, ORG, d, ctx); expect(c.complete).toBe(false); return c.reasons.join(" || "); };

describe("A. the NORMAL Phase 2 path succeeds with NO costing waiver", () => {
  it("Rep submission -> Estimator sign-off -> Manager approval: verified supplier costs satisfy the legacy cost check; nothing is waived and the sealed baseline records no cost exception", async () => {
    const d = normal();
    expect(d.estimator.costBasis?.incompleteAccepted).toBeUndefined();
    expect(Object.keys(d.estimator.physicalCosts ?? {})).toHaveLength(0); // no legacy captured costs either
    const id = await stored(d);
    const total = cents(d);
    await handoff(id, total);
    expect((await loadQuote(db as never, ORG, id))!.state).toBe("ESTIMATOR_REVIEW");
    await signOff(id);
    const r = await approve(id);
    expect(r.contractCents).toBe(total);
    expect(r.exceptionRecorded).toBe(false);
    const q = (await loadQuote(db as never, ORG, id))!;
    expect(q.state).toBe("MANAGER_APPROVED_FINAL");
    const b = q.accepted_baseline!;
    expect(b.estimator.costBasis?.incompleteAccepted).toBeUndefined();
    expect(b.exceptions).toBeUndefined();
    expect(b.physicalCostEstimate).toBeUndefined();
    expect(b.estimator.pricing!.revision).toBe(1);
  });
  it("the same path works with an independently attested forward-cover rate in place of spot", async () => {
    const f = { rateMicro: micro("19"), coverDays: 90, reference: "FEC-FIX", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "90-day forward contract", by: EST, at: AT };
    const d = normal({ forwardCover: { EUR: { ...f, review: { by: REVIEWER, at: AT, evidence: "Bank FEC confirmation", inputHash: rateInputHash("EUR", f) } } } });
    const id = await stored(d);
    await handoff(id, cents(d));
    await signOff(id);
    expect((await approve(id)).contractCents).toBe(cents(d));
  });
  it("PARTIAL legacy capture does not change that: SKUs the pricing covers are not 'missing' at the baseline freeze either", async () => {
    const d = normal();
    d.estimator.physicalCosts = { "SYSH-2750-3": { unitCostCents: 123_456, source: "MANUAL_ESTIMATE", retrievedAt: AT, reason: "fixture manual estimate", by: EST, at: AT } };
    const view = await baselineExceptionOf(db as never, ORG, d, ctx);
    expect(view.otherBlockers.join(" ")).not.toMatch(/no supplier cost selected/);
    const id = await stored(d);
    await handoff(id, cents(d));
    await signOff(id);
    expect((await approve(id)).contractCents).toBe(cents(d));
  });
});

describe("A2. partial legacy capture: the frozen legacy estimate is a DISPLAY value and never feeds totals, margin, PDFs, approval or Cin7 posting", () => {
  const MANUAL = { unitCostCents: 123_456, source: "MANUAL_ESTIMATE" as const, retrievedAt: AT, reason: "fixture manual estimate", by: EST, at: AT };
  it("approval, the contract total and the frozen internal margin come from the quotation and its Phase 2 costs, not from the partial legacy estimate", async () => {
    const d = normal();
    d.estimator.physicalCosts = { "SYSH-2750-3": MANUAL };
    const id = await stored(d);
    const total = cents(d);
    await handoff(id, total);
    await signOff(id);
    const r = await approve(id);
    expect(r.contractCents).toBe(total);
    const b = (await loadQuote(db as never, ORG, id))!.accepted_baseline!;
    expect(b.contractCents).toBe(total);
    expect(b.commercial.subtotalCents).toBe(total);
    // the frozen internal margin (what Projects profitability reads) is built from the evaluated quotation and its Phase 2 costs: it is IDENTICAL to the one frozen for the same quotation with
    // no legacy capture at all, so the partial legacy estimate has no influence on it
    const d2 = normal();
    const id2 = await stored(d2);
    await handoff(id2, cents(d2)); await signOff(id2); await approve(id2);
    const b2 = (await loadQuote(db as never, ORG, id2))!.accepted_baseline!;
    expect(JSON.stringify(b.internalMargin)).toBe(JSON.stringify(b2.internalMargin));
    expect(JSON.stringify(b.commercial)).toBe(JSON.stringify(b2.commercial));
    expect(b2.physicalCostEstimate).toBeUndefined();
    // the legacy estimate is frozen honestly as captured: the SKUs only Phase 2 costs are listed as having no LEGACY cost (display only)
    expect(b.physicalCostEstimate!.incomplete).toBe(true);
    expect(b.physicalCostEstimate!.missingSkus).toContain("PNQ082");
    // the customer-document leak scanner reads it only to know which figures must NOT appear; missing costs add nothing and it does not throw
    const t = internalTokenSet(b);
    expect(t.figures).toContain("1234.56");
  });
  it("evidence: only the known internal/display readers touch physicalCostEstimate: no Cin7 posting, sync, claim, invoice or customer-document code reads it", () => {
    const root = join(__dirname, "..", "..", "..");
    const files: string[] = [];
    const walk = (dir: string) => { for (const n of readdirSync(dir)) { const f = join(dir, n); if (statSync(f).isDirectory()) { if (n !== "__tests__" && n !== "node_modules") walk(f); } else if (/\.(ts|tsx)$/.test(n)) files.push(f); } };
    walk(root);
    const readers = files.filter((f) => /physicalCostEstimate/.test(readFileSync(f, "utf8"))).map((f) => f.slice(root.length + 1).replace(/\\/g, "/")).sort();
    expect(readers).toEqual([
      "app/newquip-grower/[id]/page.tsx", // a note shown only when an incomplete-cost exception was accepted
      "app/newquip-grower/cost-actions.ts", // the legacy CostPanel's frozen view
      "app/projects/procurement-actions.ts", // the Projects "Cost targets" comparison
      "lib/newquip-quotes/customer-document.ts", // the leak scanner (figures that must NOT appear)
      "newquip/quote/baseline.ts", // where it is frozen
      "newquip/quote/margin.ts", // Rep redaction (deletes it)
    ]);
  });
});

describe("B. legacy behaviour is preserved where supplier pricing is not in use", () => {
  it("a quotation WITHOUT supplier pricing and without a waiver is still refused sign-off for the legacy 'no supplier cost selected' reason", async () => {
    const d = noWaiver(readyDraft());
    expect(d.estimator.pricing).toBeUndefined();
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(/no supplier cost selected/);
  });
  it("partial legacy capture without supplier pricing still blocks the baseline freeze view", async () => {
    const d = noWaiver(readyDraft());
    d.estimator.physicalCosts = { "SYSH-2750-3": { unitCostCents: 123_456, source: "MANUAL_ESTIMATE", retrievedAt: AT, reason: "fixture manual estimate", by: EST, at: AT } };
    const view = await baselineExceptionOf(db as never, ORG, d, ctx);
    expect(view.otherBlockers.join(" ")).toMatch(/no supplier cost selected/);
  });
  it("a legacy quotation with the authorised exception behaves exactly as before (the exception still works for legacy costs)", async () => {
    const d = readyDraft();
    expect(d.estimator.costBasis?.incompleteAccepted).toBeDefined();
    const id = await stored(d);
    await handoff(id, cents(d));
    await signOff(id);
    expect((await approve(id)).contractCents).toBe(cents(d));
  });
});

describe("C. nothing unverified, missing, stale or unrelated is ever treated as complete", () => {
  it("Estimator-priced package components (M75 / penning / LED mapped SKUs) with NO cost of their own stay listed: the legacy reason names exactly them", async () => {
    const d = noWaiver(withPricing(equivalentInputs({}, "verified"))); // verified costs for the catalogue SKUs only
    const id = await stored(d);
    await handoff(id, cents(d));
    const e = await err(signOff(id));
    expect(e).toMatch(SIGNOFF_BLOCKED);
    expect(e).toMatch(/3 SKU\(s\) have no supplier cost selected \(FIXTURE-M75, FIXTURE-PENNING, FIXTURE-LED\)/);
  });
  it("a cost recorded for an UNRELATED SKU covers nothing in this quotation's scope", async () => {
    const p = equivalentInputs({}, "verified");
    for (const k of COMPONENTS) delete p.skus[k];
    p.skus["SOME-OTHER-SKU"] = reviewedEntry();
    const d = noWaiver(withPricing(p));
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(/3 SKU\(s\) have no supplier cost selected/);
  });
  it("a MISSING supplier cost leaves the quotation BLOCKED (never priced at zero) and nothing can be signed off", async () => {
    const p = completePricing(); delete p.skus.ERT053;
    const d = noWaiver(withPricing(p));
    expect(evaluateDraft(d, ctx).readiness.state).toBe("BLOCKED");
    const id = await stored(d);
    expect(await err(signOff(id))).toMatch(/not possible from Rep draft|BLOCKED|price/i);
  });
  it("an UNVERIFIED cost supports an indicative handoff but blocks sign-off and approval, waiver or not", async () => {
    const p = completePricing(); delete p.skus.PNQ082!.review;
    const d = noWaiver(withPricing(p));
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(SIGNOFF_BLOCKED);
    expect(await reasonsOf(d)).toMatch(/PNQ082: the supplier cost has not been independently verified.*cannot be waived/);
    expect(await err(approve(id))).toMatch(/Costing is incomplete|has not signed off/);
  });
  it("a cost 'verified' by the person who entered it is not independent: blocked", async () => {
    const p = completePricing();
    const e = { ...p.skus.PNQ082!, review: undefined };
    p.skus.PNQ082 = { ...e, review: { by: EST, at: AT, evidence: "self", inputHash: costInputHash(e) } };
    const d = noWaiver(withPricing(p));
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(SIGNOFF_BLOCKED);
    expect(await reasonsOf(d)).toMatch(/PNQ082: .*verified by the person who entered it/);
  });
  it("a cost changed after it was verified (stale verification) is blocked until verified again", async () => {
    const p = completePricing();
    p.skus.PNQ082 = { ...p.skus.PNQ082!, nativeUnitCostE7: p.skus.PNQ082!.nativeUnitCostE7 + 10_000_000 }; // +1.00 native, review hash no longer matches
    const d = noWaiver(withPricing(p));
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(SIGNOFF_BLOCKED);
    expect(await reasonsOf(d)).toMatch(/PNQ082: .*changed after it was verified/);
  });
  it("an unattested forward-cover rate is mandatory-blocking", async () => {
    const d = normal({ forwardCover: { EUR: { rateMicro: micro("19"), coverDays: 90, reference: "FEC-FIX", validFrom: "2026-11-01", validUntil: "2026-12-31", reason: "90-day forward contract", by: EST, at: AT } } });
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(SIGNOFF_BLOCKED);
    expect(await reasonsOf(d)).toMatch(/EUR forward-cover rate.*independently attested.*cannot be waived/);
  });
  it("a missing freight / landed-cost assumption blocks (never assumed)", async () => {
    const p = completePricing();
    const e = { ...p.skus.PNQ082!, freight: null, review: undefined };
    p.skus.PNQ082 = { ...e, review: { by: REVIEWER, at: AT, evidence: "q", inputHash: costInputHash(e) } };
    const d = noWaiver(withPricing(p));
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(SIGNOFF_BLOCKED);
    expect(await reasonsOf(d)).toMatch(/PNQ082: no freight \/ landed-cost assumption is recorded.*cannot be waived/);
  });
  it("missing pricing evidence for a SKU-less manual item (LED / penning / M75) blocks", async () => {
    const p = completePricing(); delete p.manualEvidence;
    const d = noWaiver(withPricing(p));
    const id = await stored(d);
    await handoff(id, cents(d));
    expect(await err(signOff(id))).toMatch(SIGNOFF_BLOCKED);
    expect(await reasonsOf(d)).toMatch(/cannot be waived/);
    expect(await reasonsOf(d)).toMatch(/evidence|pricing basis/i);
  });
});

describe("D. changes invalidate stale sign-off, and an approved quotation is immutable", () => {
  it("a cost changed AFTER Estimator sign-off withdraws the sign-off: approval is refused until it is signed off and verified again", async () => {
    const d = normal();
    const id = await stored(d);
    await handoff(id, cents(d));
    await signOff(id);
    const changed = normal(); changed.estimator.pricing!.skus.PNQ082 = { ...changed.estimator.pricing!.skus.PNQ082!, nativeUnitCostE7: changed.estimator.pricing!.skus.PNQ082!.nativeUnitCostE7 + 10_000_000 };
    await saveDraft(db as never, ORG, member, id, changed);
    expect(await err(approve(id))).toMatch(/has not signed off|Costing is incomplete|not possible/i);
  });
  it("an approved quotation can no longer be changed: pricing, scope and verification are frozen", async () => {
    const d = normal();
    const id = await stored(d);
    await handoff(id, cents(d));
    await signOff(id);
    await approve(id);
    const before = (await loadQuote(db as never, ORG, id))!;
    const tampered = normal(); tampered.estimator.pricing!.skus.PNQ082 = { ...tampered.estimator.pricing!.skus.PNQ082!, nativeUnitCostE7: 1 };
    expect(await err(saveDraft(db as never, ORG, member, id, tampered))).not.toBe("");
    const after = (await loadQuote(db as never, ORG, id))!;
    expect(after.state).toBe("MANAGER_APPROVED_FINAL");
    expect(after.draft_hash).toBe(before.draft_hash);
    expect(JSON.stringify(after.accepted_baseline)).toBe(JSON.stringify(before.accepted_baseline));
  });
});
