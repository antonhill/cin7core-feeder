import { describe, expect, it } from "vitest";
import { readyDraft } from "../../grower/__tests__/golden";
import { emptyDraft } from "../../grower/draft";
import { pricingFeedback, completenessOf } from "../pricing-feedback";
import { cloneDraft, evalOf } from "./helpers";

describe("pricing feedback for the Rep", () => {
  it("a fully priced quotation is 'Indicative price: Complete' - and still says it is not final", () => {
    const f = pricingFeedback(evalOf(readyDraft(), true).budget, { canViewCommercials: false });
    expect(f.completeness).toBe("complete");
    expect(f.label).toBe("Indicative price: Complete");
    expect(f.detail).toMatch(/still an indicative price/);
    expect(f.reasons).toEqual([]);
  });
  it("a quotation with unresolved lines is 'Provisional', says how many await the Estimator and lists what is outstanding", () => {
    const d = cloneDraft((x) => { x.estimator.confirmedMappings = {}; x.estimator.priceResolutions = {}; });
    const budget = evalOf(d, true).budget!;
    const f = pricingFeedback(budget, { canViewCommercials: false });
    expect(budget.state).toBe("partial");
    expect(f.completeness).toBe("provisional");
    expect(f.label).toBe("Indicative price: Provisional");
    expect(f.awaitingEstimatorLines).toBeGreaterThan(0);
    expect(f.detail).toMatch(/await the Estimator/);
    expect(f.reasons.length).toBeGreaterThan(0);
  });
  it("nothing priced reads 'Not priced yet' and says no price is shown as zero", () => {
    const b = evalOf(emptyDraft(), true).budget;
    const f = pricingFeedback(b, { canViewCommercials: false });
    expect(completenessOf(b)).toBe("not_priced");
    expect(f.label).toBe("Indicative price: Not priced yet");
    expect(f.detail).toMatch(/No price is shown as zero/);
  });
  it("a viewer without cost visibility never receives cost-basis wording in the reasons", () => {
    const d = cloneDraft((x) => { x.estimator.priceResolutions = {}; });
    const budget = evalOf(d, false).budget!; // cost-visible evaluation: its blockers may say 'landed cost'
    const rep = pricingFeedback(budget, { canViewCommercials: false });
    expect(JSON.stringify(rep)).not.toMatch(/landed cost|workbook|ROE|freight|markup/i);
  });
});
