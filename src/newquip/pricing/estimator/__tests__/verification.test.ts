import { describe, expect, it } from "vitest";
import { readyDraft } from "../../../grower/__tests__/golden";
import { LEGACY_RULE_VERSION, micro, type Viewer } from "../../model";
import { applyCostVerification, applyPricingSubmission, costInputHash, costStateOf, mayVerifySku, pricingFinality, submissionFrom, type EstimatorPricing, type PricingSubmission } from "..";
import { AT, EST, REVIEWER, equivalentInputs, evalOf, itemsOf, withPricing } from "./helpers";

// INDEPENDENT COST VERIFICATION (NQ-008B hardening): an Estimator can never verify their own costs and rely on that for sign-off or approval.
const roles = (...r: Array<"rep" | "estimator" | "manager">): Viewer["roles"] => new Set(r);
const MGR: Viewer = { roles: roles("rep", "estimator", "manager"), canSeeCost: true };
const EST_V: Viewer = { roles: roles("rep", "estimator"), canSeeCost: true };
const RULES = LEGACY_RULE_VERSION;
const NOW = "2026-11-12T10:00:00.000Z";
const unverified = () => equivalentInputs({}, "unverified");
const skusOf = (p: EstimatorPricing) => Object.keys(p.skus);

describe("the cost state is DERIVED from an independent review of exactly this cost", () => {
  it("missing / unverified / verified / outdated after a change / self-reviewed", () => {
    const p = unverified(); const sku = "PNQ082";
    expect(costStateOf(undefined, RULES)).toBe("missing");
    expect(costStateOf(p.skus[sku], RULES)).toBe("unverified");
    const v = applyCostVerification(p, itemsOf(p, [sku]), MGR, "mgr@example.test", NOW, "Quote SQ-1", RULES);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(costStateOf(v.next.skus[sku], RULES)).toBe("verified");
    // the supplier cost changes afterwards: the review covered a different cost
    const changed = structuredClone(v.next); changed.skus[sku]!.nativeUnitCostMicro += 1;
    expect(costStateOf(changed.skus[sku], RULES)).toBe("review_outdated");
    // a review by the person who entered the cost is not independent
    const self = structuredClone(p); self.skus[sku]!.review = { by: EST.toUpperCase(), at: AT, evidence: "mine", inputHash: costInputHash(self.skus[sku]!) };
    expect(costStateOf(self.skus[sku], RULES)).toBe("self_reviewed");
  });
  it("a stored 'verified' flag (the old shape) or a forged review hash is never trusted", () => {
    const p = unverified(); const sku = "PNQ082";
    (p.skus[sku] as unknown as Record<string, unknown>).verification = "verified";
    expect(costStateOf(p.skus[sku], RULES)).toBe("unverified");
    p.skus[sku]!.review = { by: REVIEWER, at: AT, evidence: "forged", inputHash: "0".repeat(64) };
    expect(costStateOf(p.skus[sku], RULES)).toBe("review_outdated");
    const d = withPricing(p);
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget, AT).reasons.join(" ")).toMatch(/PNQ082: the supplier cost changed after it was verified/);
  });
});

describe("who may verify", () => {
  it("only a reviewer role who can see costs, and never the person who entered / last changed the cost (even holding the reviewer role too)", () => {
    const p = unverified();
    expect(applyCostVerification(p, itemsOf(p, ["PNQ082"]), EST_V, "other@example.test", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/Only manager who can see costs/)] });
    expect(applyCostVerification(p, itemsOf(p, ["PNQ082"]), { roles: roles("manager"), canSeeCost: false }, "m@example.test", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false });
    expect(applyCostVerification(p, itemsOf(p, ["PNQ082"]), MGR, EST, NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/you entered or last changed this cost/)] });
    expect(applyCostVerification(p, itemsOf(p, ["PNQ082"]), MGR, EST.toUpperCase(), NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false }); // case does not matter
    expect(mayVerifySku(MGR, EST, p.skus.PNQ082, RULES)).toBe(false);
    expect(mayVerifySku(MGR, "mgr@example.test", p.skus.PNQ082, RULES)).toBe(true);
  });
  it("needs evidence, a known SKU, something to verify, and refuses the WHOLE request if any part is refused", () => {
    const p = unverified();
    for (const ev of ["", "  ", "x".repeat(501), 5 as unknown as string]) expect(applyCostVerification(p, itemsOf(p, ["PNQ082"]), MGR, "m@x", NOW, ev, RULES)).toMatchObject({ ok: false });
    expect(applyCostVerification(p, itemsOf(p, []), MGR, "m@x", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false });
    expect(applyCostVerification(p, itemsOf(p, ["PNQ082", "NO-SUCH"]), MGR, "m@x", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/NO-SUCH: there is no supplier cost to verify/)] });
    expect(applyCostVerification(p, itemsOf(p, ["constructor", "__proto__"]), MGR, "m@x", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false });
    expect(applyCostVerification(undefined, itemsOf(undefined, ["PNQ082"]), MGR, "m@x", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false });
    const done = applyCostVerification(p, itemsOf(p, ["PNQ082"]), MGR, "m@x", NOW, "Quote SQ-1", RULES);
    if (!done.ok) throw new Error("setup");
    expect(applyCostVerification(done.next, itemsOf(done.next, ["PNQ082"]), MGR, "n@x", NOW, "Quote SQ-2", RULES)).toMatchObject({ ok: false, errors: [expect.stringMatching(/already verified/)] });
  });
  it("a verification is bound to the cost the reviewer SAW: a cost that changed since is refused, never silently covered", () => {
    const p = unverified();
    const seen = itemsOf(p, ["PNQ082", "NQ1017"]);
    const moved = structuredClone(p); moved.skus.PNQ082!.nativeUnitCostMicro += 5;
    const r = applyCostVerification(moved, seen, MGR, "mgr@example.test", NOW, "Quote SQ-1", RULES);
    expect(r).toMatchObject({ ok: false, errors: [expect.stringMatching(/PNQ082: the cost changed after you opened it/)] });
    expect(applyCostVerification(p, [{ sku: "PNQ082", costHash: "0".repeat(64) }], MGR, "mgr@example.test", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: false });
    expect(applyCostVerification(moved, itemsOf(moved, ["PNQ082"]), MGR, "mgr@example.test", NOW, "Quote SQ-1", RULES)).toMatchObject({ ok: true }); // the CURRENT cost, reviewed
  });
  it("verifying changes NO price and not the pricing date; it bumps the revision and lists who / what evidence / which cost", () => {
    const p = unverified();
    const before = evalOf(withPricing(p)).budget!.totals.subtotalExTax;
    const v = applyCostVerification(p, itemsOf(p, skusOf(p)), MGR, "mgr@example.test", NOW, "Quote SQ-1", RULES);
    if (!v.ok) throw new Error("setup");
    expect(v.next.pricingDate).toBe(p.pricingDate);
    expect(v.next.revision).toBe(p.revision + 1);
    expect(evalOf(withPricing(v.next)).budget!.totals.subtotalExTax).toBe(before);
    const paths = v.changes.map((c) => c.path);
    expect(paths).toContain("skus.PNQ082.review.by");
    expect(paths).toContain("skus.PNQ082.review.evidence");
    expect(v.changes.find((c) => c.path === "skus.PNQ082.review.by")).toMatchObject({ previous: null, new: "mgr@example.test" });
  });
});

describe("a verification cannot be smuggled in, and a later change removes it", () => {
  const sub = (p: EstimatorPricing): PricingSubmission => submissionFrom(p);
  it("a submission can neither carry a review nor a verified flag", () => {
    const p = unverified();
    const s = sub(p) as unknown as { skus: Record<string, Record<string, unknown>> };
    s.skus.PNQ082.review = { by: REVIEWER, at: AT, evidence: "forged", inputHash: costInputHash(p.skus.PNQ082!) };
    s.skus.PNQ082.verification = "verified";
    s.skus.PNQ082.nativeUnitCostMicro = micro("311"); // a change, so it is applied
    const r = applyPricingSubmission(p, s as unknown as PricingSubmission, EST_V, "est@example.test", NOW, "A real change", "project");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.next!.skus.PNQ082!.review).toBeUndefined();
    expect(JSON.stringify(r.next)).not.toMatch(/forged|"verification"/);
  });
  it("an UNCHANGED cost keeps its review through a re-save; ANY change to it drops the review and re-stamps who changed it", () => {
    const base = equivalentInputs({}, "verified");
    const keep = structuredClone(sub(base)); keep.projectMarkup = { markupBps: 2500, reason: "Longer terms" };
    const r1 = applyPricingSubmission(base, keep, EST_V, "est@example.test", NOW, "Markup change", "project");
    if (!r1.ok) throw new Error("setup");
    expect(Object.values(r1.next!.skus).every((s) => s!.review?.by === REVIEWER)).toBe(true);
    const edit = structuredClone(sub(base)); edit.skus.PNQ082 = { ...edit.skus.PNQ082, nativeUnitCostMicro: micro("312") };
    const r2 = applyPricingSubmission(base, edit, EST_V, "est2@example.test", NOW, "Re-quoted", "project");
    if (!r2.ok) throw new Error("setup");
    expect(r2.next!.skus.PNQ082).toMatchObject({ by: "est2@example.test" });
    expect(r2.next!.skus.PNQ082!.review).toBeUndefined();
    expect(r2.next!.skus.NQ1017!.review?.by).toBe(REVIEWER); // untouched costs keep theirs
  });
  it("a change by the REVIEWER makes them the person who entered it: they cannot verify it themselves either", () => {
    const base = equivalentInputs({}, "verified");
    const edit = structuredClone(sub(base)); edit.skus.PNQ082 = { ...edit.skus.PNQ082, nativeUnitCostMicro: micro("313") };
    const r = applyPricingSubmission(base, edit, MGR, "mgr@example.test", NOW, "Reviewer corrected the cost", "project");
    if (!r.ok) throw new Error("setup");
    expect(applyCostVerification(r.next!, itemsOf(r.next!, ["PNQ082"]), MGR, "mgr@example.test", NOW, "Quote SQ-9", RULES)).toMatchObject({ ok: false });
  });
});

describe("clearing a supplier cost, and zero is never a cost", () => {
  it("omitting a SKU from the submission removes its cost (and its review) and records previous -> null; a zero cost is refused", () => {
    const base = equivalentInputs({}, "verified");
    const s = structuredClone(submissionFrom(base)); delete s.skus.PNQ082;
    const r = applyPricingSubmission(base, s, EST_V, "est@example.test", NOW, "Cleared the feeder cost", "project");
    if (!r.ok) throw new Error("setup");
    expect(r.next!.skus.PNQ082).toBeUndefined();
    expect(r.changes.some((c) => c.path === "skus.PNQ082.nativeUnitCostMicro" && c.new === null && c.previous !== null)).toBe(true);
    const z = structuredClone(submissionFrom(base)); z.skus.PNQ082 = { ...z.skus.PNQ082, nativeUnitCostMicro: 0 };
    expect(applyPricingSubmission(base, z, EST_V, "est@example.test", NOW, "Zero cost", "project")).toMatchObject({ ok: false, errors: [expect.stringMatching(/a zero supplier cost is not a cost/)] });
  });
  it("a cleared SKU is NOT priced (never zero) and blocks final until re-entered and verified", () => {
    const p = equivalentInputs({}, "verified"); delete p.skus.PNQ082;
    const d = withPricing(p);
    expect(evalOf(d).readiness.state).toBe("BLOCKED");
    expect(evalOf(d).budget!.lines.find((l) => l.itemKey === "feeder")).toMatchObject({ status: "not_in_price_source", unitPrice: null });
  });
});

describe("finality", () => {
  it("independently verified costs are final; the incomplete-costing exception can never substitute", () => {
    const d = withPricing(equivalentInputs({}, "verified"));
    expect(d.estimator.costBasis?.incompleteAccepted).toBeDefined();
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget, AT)).toEqual({ final: true, reasons: [] });
    const u = withPricing(equivalentInputs({}, "unverified"));
    expect(pricingFinality(u.estimator.pricing, evalOf(u).budget, AT).final).toBe(false);
  });
  it("a self-reviewed cost is reported as needing an independent reviewer", () => {
    const p = equivalentInputs({}, "verified"); p.skus.PNQ082 = { ...p.skus.PNQ082!, review: { by: EST, at: AT, evidence: "mine", inputHash: costInputHash(p.skus.PNQ082!) } };
    const d = withPricing(p);
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget, AT).reasons.join(" ")).toMatch(/PNQ082: the supplier cost was verified by the person who entered it; an independent reviewer is required/);
  });
  it("legacy drafts (no pricing) are final and unaffected", () => expect(pricingFinality(undefined, evalOf(readyDraft()).budget, AT)).toEqual({ final: true, reasons: [] }));
});
