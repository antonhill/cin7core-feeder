import { describe, expect, it } from "vitest";
import { neutraliseCostWording, redactEvaluationFinancials, redactInternalFinancials } from "../margin";
import { encodeManualReason } from "../estimator-workspace";

// The EVIDENCE of a manual quotation price (supplier quote references) is for cost-entitled roles. A viewer who may not see cost keeps reading the REASON exactly as before.
const stored = encodeManualReason("No SKU exists for the FORTIS 1.2 yet", "Supplier quote SQ-9981, dated 12 Nov, from J. Supplier");
const SECRET = /SQ-9981|J\. Supplier|EVIDENCE/;

describe("manual-price evidence is not shown to a viewer who may not see cost", () => {
  it("the reason survives, the evidence is gone, in the neutralising text rule", () => {
    const out = neutraliseCostWording(`MANUAL QUOTATION PRICE - exceptional - reason: ${stored}`);
    expect(out).toBe("MANUAL QUOTATION PRICE - exceptional - reason: No SKU exists for the FORTIS 1.2 yet");
    expect(out).not.toMatch(SECRET);
  });
  it("an earlier free-text reason is untouched", () => { expect(neutraliseCostWording("reason: Phoned the supplier")).toBe("reason: Phoned the supplier"); });
  it("the quote record sent to a non-cost viewer: the draft's resolution reason and the sealed baseline carry the reason only", () => {
    const quote = { draft: { estimator: { priceResolutions: { led_light: { unitPriceExVat: 881, reason: stored } } } }, accepted_baseline: { priceResolutions: [{ itemKey: "led_light", unitPriceExVat: 881, reason: stored }], estimator: {} } } as never;
    const rep = redactInternalFinancials(quote, false) as unknown as { draft: { estimator: { priceResolutions: { led_light: { reason: string } } } }; accepted_baseline: { priceResolutions: Array<{ reason: string }> } };
    expect(rep.draft.estimator.priceResolutions.led_light.reason).toBe("No SKU exists for the FORTIS 1.2 yet");
    expect(rep.accepted_baseline.priceResolutions[0].reason).toBe("No SKU exists for the FORTIS 1.2 yet");
    expect(JSON.stringify(rep)).not.toMatch(SECRET);
  });
  it("a cost-entitled viewer still gets the full stored text", () => {
    const quote = { draft: { estimator: { priceResolutions: { led_light: { unitPriceExVat: 881, reason: stored } } } }, accepted_baseline: null } as never;
    expect((redactInternalFinancials(quote, true) as unknown as { draft: { estimator: { priceResolutions: { led_light: { reason: string } } } } }).draft.estimator.priceResolutions.led_light.reason).toBe(stored);
  });
  it("the evaluation sent to a non-cost viewer: a manual-price line's reason carries no evidence", () => {
    const ev = { budget: { quoteType: "project", totals: {}, priceSource: { id: "x", basis: "" }, lines: [{ itemKey: "led_light", status: "priced", reason: `MANUAL QUOTATION PRICE - exceptional, not from the approved price source (Package awaiting estimator confirmation.) - reason: ${stored}` }], readiness: [] } } as never;
    const rep = redactEvaluationFinancials(ev, false);
    expect(JSON.stringify(rep)).not.toMatch(SECRET);
    expect(JSON.stringify(rep)).toMatch(/No SKU exists for the FORTIS 1\.2 yet/);
  });
});
