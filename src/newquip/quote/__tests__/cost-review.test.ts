import { describe, expect, it } from "vitest";
import { buildCostReview, nativeCostText, STATUS_LEGEND, UPLIFT_NONE, UPLIFT_NOTE } from "../cost-review";

const row = (over: Record<string, unknown> = {}) => ({
  sku: "ERT053", usedBy: ["feed_saver_mat"], quantity: 216, status: "priced", supplier: "Mat Supplier", currency: "EUR", nativeUnitCostE7: 268_440_995, costSource: "Quote Q-77",
  costState: "unverified", costStateText: "Entered, not yet verified", enteredBy: "estimator@x", enteredAt: "2026-11-10T08:30:00Z", review: null, priceBasis: "supplier_pricing", costHash: "h",
  rate: { currency: "EUR", rateMicro: 18_419_500, kind: "spot", source: "bank", asOf: "2026-11-10T07:00:00Z", coverDays: null }, freightFactorMicro: 1_100_000, freightAddOnCents: null,
  unitLandedCostCents: 54_390, calculatedUnitPriceCents: 65_268, unitPriceCents: 65_268, priceOrigin: "rule_markup", priceOverride: null, lineRevenueCents: 14_097_888, lineCostCents: 11_748_240,
  margin: { sellingCents: 14_097_888, costCents: 11_748_240, gpCents: 2_349_648, marginPct: 16.67, markupPct: 20 }, issues: [], ...over,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const view = (rows: any[]) => ({ rows }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const budget = { lines: [{ itemKey: "feed_saver_mat", label: "Feed saver mat (1m × 1m)", sku: "ERT053", components: [] }] } as any;

describe("the itemised cost review", () => {
  it("shows every value side by side, exactly as the model holds it, and applies no historical uplift", () => {
    const [r] = buildCostReview(view([row()]), budget).rows;
    expect(r.sku).toBe("ERT053");
    expect(r.description).toBe("Feed saver mat (1m × 1m)");
    expect(r.quantity.text).toBe("216");
    expect(r.source.text).toBe("Mat Supplier · Quote Q-77");
    expect(r.costDate.text).toBe("2026-11-10");
    expect(r.originalCost.text).toBe("EUR 26.8440995"); // seven decimals, never rounded
    expect(r.uplift.text).toBe(UPLIFT_NONE);
    expect(r.fx.text).toBe("EUR 18.4195 · spot · 2026-11-10");
    expect(r.freight.text).toBe("× 1.100");
    expect(r.landedUnit.text).toBe("R 543,90");
    expect(r.totalCost.text).toBe("R 117 482,40");
    expect(r.selling.text).toBe("R 140 978,88");
    expect(r.margin.text).toBe("16.7%");
    expect(r.status).toEqual({ text: "Needs verification", tone: "open" });
    expect(r.statusDetail).toBeNull(); // the standard case is explained once in the legend, not on every row
  });

  it("a verified cost is verified; a missing cost is named as missing and nothing is invented for it", () => {
    const missingRow = row({ sku: "NQ1161", status: "no_input", costState: "missing", costStateText: "No supplier cost", supplier: null, currency: null, nativeUnitCostE7: null, costSource: null, enteredAt: null, rate: null, freightFactorMicro: null, unitLandedCostCents: null, lineCostCents: null, lineRevenueCents: null, margin: null });
    const rv = buildCostReview(view([row({ costState: "verified", costStateText: "Verified" }), missingRow]), budget);
    expect(rv.rows[0].status).toEqual({ text: "Verified", tone: "ok" });
    expect(rv.rows[0].statusDetail).toBeNull();
    const m = rv.rows[1];
    expect(m.status).toEqual({ text: "Missing cost", tone: "missing" });
    for (const c of [m.source, m.originalCost, m.landedUnit, m.totalCost, m.selling, m.margin]) expect(c.tone, c.text).toBe("missing");
    expect(m.landedUnit.text).toBe("Not available");
    expect(m.missing).toEqual(expect.arrayContaining(["supplier cost", "original cost"]));
    expect(rv.counts).toEqual({ products: 2, verified: 1, missing: 1, unverified: 0, provisional: 0 });
  });

  it("a foreign cost with no usable rate says so; a ZAR cost needs none; self-review and a changed cost are not 'verified'", () => {
    const [noRate, zar, self, changed] = buildCostReview(view([row({ rate: null }), row({ currency: "ZAR", nativeUnitCostE7: 300_000_000, rate: null }), row({ costState: "self_reviewed", costStateText: "" }), row({ costState: "review_outdated", costStateText: "" })]), budget).rows;
    expect(noRate.fx).toEqual({ text: "No usable exchange rate", tone: "missing" });
    expect(zar.fx.text).toBe("ZAR: no conversion");
    expect(self.status).toEqual({ text: "Needs verification", tone: "open" });
    expect(self.statusDetail).toMatch(/not independent/);
    expect(changed.status).toEqual({ text: "Needs verification", tone: "open" });
    expect(changed.statusDetail).toMatch(/changed after it was verified/);
  });

  it("no historical inflation is calculated: the uplift is always 'none applied' and the note says the model has no age-based escalation", () => {
    const rv = buildCostReview(view([row({ enteredAt: "2019-01-01T00:00:00Z" })]), budget);
    expect(rv.rows[0].uplift.text).toBe(UPLIFT_NONE); // an old cost is NOT escalated
    expect(rv.rows[0].originalCost.text).toBe("EUR 26.8440995");
    expect(rv.upliftNote).toBe(UPLIFT_NOTE);
    expect(UPLIFT_NOTE).toMatch(/no age-based escalation/);
  });

  it("native costs are shown exactly", () => {
    expect(nativeCostText(300_000_000, "ZAR")).toBe("ZAR 30");
    expect(nativeCostText(1_936_000_000, "ZAR")).toBe("ZAR 193.6");
    expect(nativeCostText(65_454_755, "USD")).toBe("USD 6.5454755");
  });

  it("only products the quotation actually uses are listed", () => {
    expect(buildCostReview(view([row({ usedBy: [] })]), budget).rows).toHaveLength(0);
  });

  it("a manually priced line is Provisional (its supplier cost still needs verification); the four labels are explained once in the legend", () => {
    const rv = buildCostReview(view([row({ priceBasis: "manual_price", costState: "verified", costStateText: "Verified" })]), budget);
    expect(rv.rows[0].status).toEqual({ text: "Provisional", tone: "open" });
    expect(rv.rows[0].statusDetail).toMatch(/manual selling price/);
    expect(rv.counts.provisional).toBe(1);
    expect(STATUS_LEGEND.map(([k]) => k)).toEqual(["Verified", "Needs verification", "Missing cost", "Provisional"]);
  });
});
