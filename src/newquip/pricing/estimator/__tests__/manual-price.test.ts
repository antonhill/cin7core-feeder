import { describe, expect, it } from "vitest";
import { readyDraft } from "../../../grower/__tests__/golden";
import { applyCostVerification, buildPricingWorkspace, LEGACY_RULE_VERSION, manualPricedSkus, pricingFinality, type EstimatorPricing } from "..";
import { AT, equivalentInputs, evalOf, itemsOf, withPricing } from "./helpers";

// MANUAL PRICE EXCEPTIONS (NQ-008B hardening): a manually entered SELLING price never conceals a missing or unverified SUPPLIER COST. Price completeness and cost verification are
// reported separately, and final approval is blocked until the required costs are recorded and independently verified.
// In the fixture the feed-saver mat (ERT053) and concrete slat (NQ1161) carry the legacy manual price resolutions; led_light has no SKU (Estimator-priced by design, outside this rule).
const draftWith = (p: EstimatorPricing) => { const d = withPricing(p); d.estimator.priceResolutions = { ...d.estimator.priceResolutions, feed_saver_mat: { unitPriceExVat: 919, reason: "Manual price: the workbook has none" }, concrete_slat: { unitPriceExVat: 203, reason: "Manual price: the workbook has none" } }; return d; };
const MGR = { roles: new Set(["rep", "estimator", "manager"] as const), canSeeCost: true } as never;

describe("a manual price with NO supplier cost recorded", () => {
  const p = equivalentInputs({}, "verified"); delete p.skus.ERT053; delete p.skus.NQ1161;
  const d = draftWith(p); const ev = evalOf(d);
  it("still gives the line a price (price complete) but is flagged and blocks finality: the cost is missing, the manual price does not hide it", () => {
    expect(ev.budget!.lines.find((l) => l.itemKey === "feed_saver_mat")).toMatchObject({ status: "priced", pricedBy: "estimator_resolution" });
    expect(ev.budget!.incomplete).toBe(false); // PRICE completeness: every line has a price
    expect(manualPricedSkus(ev.budget)).toEqual(["ERT053", "NQ1161"]);
    const f = pricingFinality(d.estimator.pricing, ev.budget, AT);
    expect(f.final).toBe(false);
    expect(f.reasons).toEqual(expect.arrayContaining([expect.stringMatching(/ERT053: priced by a manual price, but no supplier cost has been entered/), expect.stringMatching(/NQ1161: priced by a manual price, but no supplier cost has been entered/)]));
    expect(f.reasons.join(" ")).toMatch(/cannot be waived by the incomplete-costing exception/);
  });
  it("the workspace shows the two things separately: the line is priced by a MANUAL price, its cost is missing, and the verified count excludes it", () => {
    const v = buildPricingWorkspace({ quoteType: "project", pricing: d.estimator.pricing, budget: ev.budget, originalTotalCents: null, originalCapturedAt: null, nowIso: AT });
    const row = v.rows.find((r) => r.sku === "ERT053")!;
    expect(row).toMatchObject({ status: "no_input", priceBasis: "manual_price", costState: "missing" });
    expect(row.usedBy.length).toBeGreaterThan(0);
    expect(v.totals.priceComplete).toBe(true);
    expect(v.costs.verified).toBeLessThan(v.costs.required);
    expect(v.attention.join(" ")).toMatch(/ERT053: priced by a manual price/);
    expect(v.attention.join(" ")).not.toMatch(/ERT053: no supplier cost entered, so it is not priced/); // it IS priced; the problem is the cost
  });
});

describe("a manual price over an UNVERIFIED cost, and over a VERIFIED one", () => {
  it("unverified: blocked; independently verified: final", () => {
    const unv = draftWith(equivalentInputs({}, "unverified"));
    // with a supplier cost entered the model prices the line itself; the manual price is not used
    expect(evalOf(unv).budget!.lines.find((l) => l.itemKey === "feed_saver_mat")!.pricedBy).toBe("price_source");
    expect(pricingFinality(unv.estimator.pricing, evalOf(unv).budget, AT).reasons.join(" ")).toMatch(/ERT053: the supplier cost has not been independently verified/);
    const ver = draftWith(equivalentInputs({}, "verified"));
    expect(pricingFinality(ver.estimator.pricing, evalOf(ver).budget, AT).final).toBe(true);
  });
  it("a SKU price OVERRIDE is a manual selling price too: it is final only when that SKU's cost is independently verified", () => {
    const p = equivalentInputs({ skuPriceOverrides: { PNQ082: { unitPriceCents: 150_000, reason: "Agreed", by: "est@x", at: AT } } }, "unverified");
    const d = withPricing(p);
    expect(evalOf(d).budget!.lines.find((l) => l.itemKey === "feeder")).toMatchObject({ unitPrice: 1500 });
    expect(pricingFinality(d.estimator.pricing, evalOf(d).budget, AT).reasons.join(" ")).toMatch(/PNQ082: the supplier cost has not been independently verified/);
    const v = applyCostVerification(p, itemsOf(p, ["PNQ082"]), MGR, "mgr@x", AT, "Quote SQ-1", LEGACY_RULE_VERSION);
    expect(v.ok).toBe(true);
  });
  it("lines the Estimator prices by design (M75, penning, a SKU-less manual price) are outside the rule: they never block on a missing supplier cost", () => {
    const d = withPricing(equivalentInputs({}, "verified"));
    expect(manualPricedSkus(evalOf(d).budget)).toEqual([]); // the fixture's only manual resolution without a SKU is led_light
    expect(evalOf(readyDraft()).budget!.lines.find((l) => l.itemKey === "led_light")!.pricedBy).toBe("estimator_resolution");
  });
});
