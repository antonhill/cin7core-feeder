import { describe, expect, it } from "vitest";
import { evaluateDraft } from "@/newquip/grower/evaluate";
import { readyDraft } from "@/newquip/grower/__tests__/golden";
import { testPriceSource } from "@/newquip/grower/__tests__/test-snapshot";
import { buildAcceptedBaseline } from "@/newquip/quote/baseline";
import { stampCostOverrides, type CostOverride } from "@/newquip/quote/margin";
import { baseCostFromBaseline } from "../project-estimated-cost";

// UAT-004: the estimator's expected Project cost (a cost override) is what the frozen approval baseline - and therefore the Project budget - uses.
// Cin7 source cost, the estimator's expected cost, the Procurement target and the actual purchase cost stay separate figures; none rewrites another.
const approvals = { customerConfirmedAt: "t", customerConfirmedCents: 1, customerConfirmedBy: "r", handoffBy: "r", estimatorSignoffBy: "e", estimatorSignoffAt: "t", managerApprovedBy: "m", managerApprovedAt: "t" };
const freezeWith = (overrides: Record<string, CostOverride>) => {
  const draft = readyDraft();
  const submitted = { ...draft, estimator: { ...draft.estimator, costOverrides: overrides as never } };
  draft.estimator.costOverrides = stampCostOverrides(submitted, undefined, true, "est@x", "2026-11-01T10:00:00Z").estimator.costOverrides;
  const ev = evaluateDraft(draft, { priceSource: testPriceSource(), withholdCost: false });
  return buildAcceptedBaseline({ quoteRef: "NQ-Q-0001", revision: 1, draft, evaluation: ev, marginEvaluation: ev, approvals }).baseline;
};
const ov = (lineCostCents: number): CostOverride => ({ lineCostCents, reason: "Supplier quote higher than Cin7 latest", by: "", at: "" });

describe("UAT-004 cost override carries into the Project budget", () => {
  it("an override changes that line's cost and margin in the frozen sheet, with its reason", () => {
    const plain = freezeWith({});
    const line = plain.internalMargin!.lines.find((l) => l.itemKey === "bulk_tank")!;
    const over = freezeWith({ bulk_tank: ov((line.costCents as number) + 500_000) });
    expect(over.internalMargin!.lines.find((l) => l.itemKey === "bulk_tank")).toMatchObject({ costBasis: "OVERRIDE", overrideReason: "Supplier quote higher than Cin7 latest", costCents: (line.costCents as number) + 500_000 });
    expect(over.internalMargin!.lines.find((l) => l.itemKey === "bulk_tank")!.gpCents).toBe((line.gpCents as number) - 500_000);
  });
  it("once every line is costed, the Project budget input equals the sheet and moves by exactly the override", () => {
    const plain = freezeWith({});
    const gaps = Object.fromEntries(plain.internalMargin!.project.missingCostLines.length ? plain.internalMargin!.lines.filter((l) => l.costCents == null).map((l) => [l.itemKey, ov(100_000)]) : []);
    const a = freezeWith(gaps);
    const bulk = a.internalMargin!.lines.find((l) => l.itemKey === "bulk_tank")!;
    const b = freezeWith({ ...gaps, bulk_tank: ov((bulk.costCents as number) + 500_000) });
    expect(a.internalMargin!.project.incomplete).toBe(false);
    expect(baseCostFromBaseline(b).estimatedCostCents).toBe(baseCostFromBaseline(a).estimatedCostCents! + 500_000);
    expect(b.internalMargin!.project.gpCents).toBe((a.internalMargin!.project.gpCents as number) - 500_000);
  });
  it("an incomplete sheet gives the Project budget NO cost (a partial total is never used)", () => {
    const plain = freezeWith({});
    if (plain.internalMargin!.project.incomplete) expect(baseCostFromBaseline(plain).estimatedCostCents).toBeNull();
  });
});
