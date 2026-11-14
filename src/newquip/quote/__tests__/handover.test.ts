import { describe, expect, it } from "vitest";
import { describeAmountChanges } from "../handover";
import { emptyDraft } from "@/newquip/grower/draft";

const d = () => emptyDraft();

describe("Estimator handover: which customer-facing inputs changed", () => {
  it("lists new selling prices, M75 price and charge changes", () => {
    const a = d(), b = d();
    b.estimator.priceResolutions = { pvc_door: { at: "t", by: "e", reason: "POC", unitPriceExVat: 2500 }, led_light: { at: "t", by: "e", reason: "POC", unitPriceExVat: 20000 } };
    b.estimator.unitPrices = { flex_auger: 3000000 };
    b.estimator.charges = { concrete_slat_delivery: 2500000 };
    const c = describeAmountChanges(a, b);
    expect(c.map((x) => x.key)).toEqual(["led_light", "pvc_door", "flex_auger", "concrete_slat_delivery"]);
    expect(c.find((x) => x.key === "pvc_door")).toMatchObject({ kind: "line price", before: null, after: 2500 });
    expect(c.find((x) => x.key === "concrete_slat_delivery")).toMatchObject({ kind: "charge", after: 2500000 });
  });
  it("ignores supplier costs, cost overrides, mappings and assumptions (they never change what the customer pays)", () => {
    const a = d(), b = d();
    b.estimator.physicalCosts = { X: { unitCostCents: 100, source: "MANUAL_ESTIMATE", retrievedAt: "t" } as never };
    b.estimator.costOverrides = { pvc_door: { amount: 5, reason: "r", by: "e", at: "t" } as never };
    b.estimator.confirmedMappings = { feeder: "PNQ082" };
    b.estimator.assumptions = "changed";
    expect(describeAmountChanges(a, b)).toEqual([]);
  });
  it("reports nothing when the prices are unchanged", () => {
    const a = d(); a.estimator.priceResolutions = { pvc_door: { at: "t", by: "e", reason: "r", unitPriceExVat: 3000 } };
    const b = structuredClone(a);
    expect(describeAmountChanges(a, b)).toEqual([]);
  });
});
