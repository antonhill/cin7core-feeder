import { describe, expect, it } from "vitest";
import { emptyDraft, type QuoteDraft } from "../../grower/draft";
import { canAcceptIncompleteCosting, canChangeMappings, canMutateCosting, changedCostingFields, costingSaveRefusal } from "../cost-authority";
import type { QuoteRole } from "../roles";

const R = (...r: QuoteRole[]) => new Set<QuoteRole>(r);
const A = (roles: Set<QuoteRole>, canSeeCost = true) => ({ roles, canSeeCost });

describe("role predicates", () => {
  it("normal costing: Estimator + cost visibility only", () => {
    expect(canMutateCosting(A(R("estimator")))).toBe(true);
    expect(canMutateCosting(A(R("rep", "estimator", "manager")))).toBe(true);
    expect(canMutateCosting(A(R("manager")))).toBe(false);
    expect(canMutateCosting(A(R("rep")))).toBe(false);
    expect(canMutateCosting(A(R("estimator"), false))).toBe(false);
  });
  it("the waiver: Manager + cost visibility only", () => {
    expect(canAcceptIncompleteCosting(A(R("manager")))).toBe(true);
    expect(canAcceptIncompleteCosting(A(R("estimator", "manager")))).toBe(true);
    expect(canAcceptIncompleteCosting(A(R("estimator")))).toBe(false);
    expect(canAcceptIncompleteCosting(A(R("rep")))).toBe(false);
    expect(canAcceptIncompleteCosting(A(R("manager"), false))).toBe(false);
  });
  it("mappings stay with Estimator and Manager", () => {
    expect(canChangeMappings(R("manager"))).toBe(true);
    expect(canChangeMappings(R("estimator"))).toBe(true);
    expect(canChangeMappings(R("rep"))).toBe(false);
  });
});

describe("changedCostingFields / costingSaveRefusal", () => {
  const base = (): QuoteDraft => { const d = emptyDraft(); d.estimator.costOverrides = { a: { lineCostCents: 100, reason: "quote", by: "e", at: "t" } } as never; d.estimator.physicalCosts = { S: { unitCostCents: 5 } } as never; d.estimator.costBasis = { unitBasis: { basis: "STOCK_UNIT" } } as never; return d; };
  it("a verbatim resubmission (and a different by/at stamp) is unchanged", () => {
    const p = base(), s = structuredClone(p);
    expect(changedCostingFields(s, p)).toEqual([]);
    (s.estimator.costOverrides as never as Record<string, { by: string }>).a.by = "someone else";
    expect(changedCostingFields(s, p)).toEqual([]);
  });
  it("absent physicalCosts / costBasis in the submission is not a change (server-owned, ignored on save); empty equals absent", () => {
    const p = base(), s = structuredClone(p); delete s.estimator.physicalCosts; delete s.estimator.costBasis;
    expect(changedCostingFields(s, p)).toEqual([]);
    expect(changedCostingFields(emptyDraft(), undefined)).toEqual([]);
  });
  it("detects each protected field", () => {
    const p = base();
    const o = structuredClone(p); (o.estimator.costOverrides as never as Record<string, { lineCostCents: number }>).a.lineCostCents = 1;
    const r = structuredClone(p); r.estimator.priceResolutions = { k: { unitPriceExVat: 1, reason: "x", by: "m", at: "t" } } as never;
    const c = structuredClone(p); (c.estimator.physicalCosts as never as Record<string, { unitCostCents: number }>).S.unitCostCents = 6;
    const b = structuredClone(p); b.estimator.costBasis = { incompleteAccepted: { reason: "r", by: "m", at: "t" } };
    expect(changedCostingFields(o, p)).toEqual(["costOverrides"]);
    expect(changedCostingFields(r, p)).toEqual(["priceResolutions"]);
    expect(changedCostingFields(c, p)).toEqual(["physicalCosts"]);
    expect(changedCostingFields(b, p)).toEqual(["costBasis"]);
  });
  it("mapping changes are never costing changes", () => {
    const p = base(), s = structuredClone(p); s.estimator.confirmedMappings = { x: { sku: "Z" } } as never;
    expect(changedCostingFields(s, p)).toEqual([]);
  });
  it("only a manager-without-estimator session is refused", () => {
    const p = base(), s = structuredClone(p); s.estimator.costBasis = { incompleteAccepted: { reason: "r", by: "m", at: "t" } };
    expect(costingSaveRefusal(R("manager"), s, p)).toMatch(/costBasis/);
    expect(costingSaveRefusal(R("rep", "manager"), s, p)).toMatch(/Only an Estimator/);
    expect(costingSaveRefusal(R("estimator"), s, p)).toBeNull();
    expect(costingSaveRefusal(R("estimator", "manager"), s, p)).toBeNull();
    expect(costingSaveRefusal(R("rep"), s, p)).toBeNull(); // a Rep is handled by the existing field-ownership revert
    expect(costingSaveRefusal(R("manager"), structuredClone(p), p)).toBeNull();
  });
});
