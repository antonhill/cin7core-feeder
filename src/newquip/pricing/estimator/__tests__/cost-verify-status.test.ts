import { describe, expect, it } from "vitest";
import { buildPricingWorkspace } from "../workspace-view";
import { nextCostVerifyAction, phase2CostNote, phase2CostStatus, phase2CostingReason, providerTimestampOf, type NextActionInput } from "../cost-verify-status";
import { equivalentInputs, evalOf, withPricing } from "./helpers";
import type { EstimatorPricing } from "../types";

const NOW = "2026-11-12T09:00:00.000Z";
const viewOf = (p: EstimatorPricing | undefined, skip?: string) => {
  const pricing = p ? { ...p, skus: { ...p.skus } } : undefined;
  if (pricing && skip) delete pricing.skus[skip];
  return buildPricingWorkspace({ quoteType: "project", pricing, budget: evalOf(withPricing(pricing ?? equivalentInputs())).budget, originalTotalCents: null, originalCapturedAt: null, nowIso: NOW });
};
const base = (status: NonNullable<ReturnType<typeof phase2CostStatus>>, over: Partial<NextActionInput> = {}): NextActionInput => ({ status, state: "ESTIMATOR_REVIEW", roles: { rep: false, estimator: true, manager: false }, dirty: false, signoff: "none", costAcknowledged: false, costNeedsMark: false, amountChanged: false, serverIncomplete: false, ...over });

describe("phase2CostStatus", () => {
  it("is null while supplier pricing is off or absent (legacy quotations are never described by it)", () => {
    expect(phase2CostStatus(viewOf(undefined))).toBeNull();
    expect(phase2CostStatus(null)).toBeNull();
    expect(phase2CostStatus(viewOf({ ...equivalentInputs(), enabled: false } as unknown as EstimatorPricing))).toBeNull();
  });
  it("verified, priced, fresh rates: complete, nothing outstanding", () => {
    const s = phase2CostStatus(viewOf(equivalentInputs({}, "verified")))!;
    expect(s.complete).toBe(true);
    expect(s.outstanding).toEqual([]);
    expect(s.verified).toBe(s.required);
    expect(phase2CostNote(s)).toMatch(/Supplier costs verified \(\d+ of \d+\)/);
  });
  it("unverified costs: names the SKUs and who may verify, never a value", () => {
    const s = phase2CostStatus(viewOf(equivalentInputs({}, "unverified")), ["manager"])!;
    expect(s.complete).toBe(false);
    expect(s.needsVerification.length).toBeGreaterThan(0);
    expect(s.outstanding.join(" ")).toMatch(/need independent verification by a Manager/);
    expect(phase2CostingReason(s)).toMatch(/^Supplier pricing is not complete: /);
    expect(phase2CostingReason(s)).not.toMatch(/no supplier cost selected/i);
  });
  it("a SKU with no supplier cost is 'to enter', not 'to verify'", () => {
    const s = phase2CostStatus(viewOf(equivalentInputs({}, "verified"), "ERT053"))!;
    expect(s.missingCost).toContain("ERT053");
    expect(s.outstanding[0]).toMatch(/supplier cost to enter \(ERT053/);
  });
  it("complete Phase 2 with a server reason still left keeps the server's own words", () => {
    const s = phase2CostStatus(viewOf(equivalentInputs({}, "verified")))!;
    expect(phase2CostingReason(s, "ZZZ: no supplier cost selected")).toBe("ZZZ: no supplier cost selected");
  });
});

describe("nextCostVerifyAction", () => {
  const ok = phase2CostStatus(viewOf(equivalentInputs({}, "verified")))!;
  const unver = phase2CostStatus(viewOf(equivalentInputs({}, "unverified")))!;
  const missing = phase2CostStatus(viewOf(equivalentInputs({}, "verified"), "ERT053"))!;
  it("enter supplier costs comes first", () => { const a = nextCostVerifyAction(base(missing)); expect(a.id).toBe("enter"); expect(a.headline).toBe("Enter supplier costs"); });
  it("N costs need independent verification by a Manager", () => { const a = nextCostVerifyAction(base(unver)); expect(a.id).toBe("verify"); expect(a.headline).toMatch(/^\d+ costs? needs? independent verification by a Manager$/); expect(a.outstanding.length).toBeGreaterThan(0); });
  it("verified + Estimator must mark reviewed: 'Mark reviewed, then sign off'", () => expect(nextCostVerifyAction(base(ok, { costNeedsMark: true })).headline).toBe("Mark reviewed, then sign off"));
  it("verified + marked: sign off", () => expect(nextCostVerifyAction(base(ok, { costAcknowledged: true })).id).toBe("signoff"));
  it("signed off: ready for Manager approval (and 'your approval' for the Manager)", () => {
    expect(nextCostVerifyAction(base(ok, { signoff: "current" })).headline).toBe("Ready for Manager approval");
    expect(nextCostVerifyAction(base(ok, { signoff: "current", roles: { rep: false, estimator: false, manager: true } })).headline).toBe("Ready for your approval");
  });
  it("with the Rep: waiting for Rep reconfirmation; amount moved: same", () => {
    expect(nextCostVerifyAction(base(ok, { state: "REP_DRAFT" })).headline).toBe("Waiting for Rep reconfirmation");
    expect(nextCostVerifyAction(base(ok, { amountChanged: true })).headline).toBe("Waiting for Rep reconfirmation");
  });
  it("unsaved edits outrank everything in review; approved is final", () => {
    expect(nextCostVerifyAction(base(unver, { dirty: true })).id).toBe("unsaved");
    expect(nextCostVerifyAction(base(unver, { state: "MANAGER_APPROVED_FINAL" })).id).toBe("approved");
  });
  it("Phase 2 complete but the server still lists something: says so with the server's reason", () => {
    const a = nextCostVerifyAction(base(ok, { serverIncomplete: true, serverReason: "XYZ has no captured supplier cost" }));
    expect(a.id).toBe("costing"); expect(a.detail).toMatch(/XYZ/);
  });
  it("the banner text never carries a cost or rate value", () => {
    const a = nextCostVerifyAction(base(unver));
    expect(JSON.stringify(a)).not.toMatch(/\d+\.\d{2,}/);
  });
});

describe("providerTimestampOf", () => {
  it("reads the provider timestamp from the stored source text", () => {
    expect(providerTimestampOf("ECB reference; provider timestamp 2026-11-14T19:00:06Z; retrieved 2026-11-14T19:05:00Z")).toBe("2026-11-14T19:00:06Z");
    expect(providerTimestampOf("Provider timestamp: 2026-11-14")).toBe("2026-11-14");
  });
  it("is null (never throws) for absent, empty, malformed or non-string input", () => {
    for (const x of [undefined, null, "", "Fixture spot", "provider timestamp soon", "provider timestamp 2026-13-45T99:99:99Z", 42 as unknown as string]) expect(providerTimestampOf(x)).toBeNull();
  });
});
