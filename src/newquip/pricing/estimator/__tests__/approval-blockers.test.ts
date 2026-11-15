import { describe, expect, it } from "vitest";
import { approvalBlockers, nextCostVerifyAction, type ApprovalBlockerInput, type NextActionInput, type Phase2CostStatus } from "../cost-verify-status";

// ONE source for "what blocks the Manager's plain Approve": the button and the Next-action banner both read it, so the banner can never say "ready" while the button is blocked.
const complete: Phase2CostStatus = { required: 3, verified: 3, missingCost: [], needsVerification: [], other: [], outstanding: [], complete: true };
const clean: ApprovalBlockerInput = { signoff: "current", dirty: false, notReadyReasons: null, costingOpen: false, baselineExceptionRequired: false };
const banner = (blockers: ApprovalBlockerInput, o: Partial<NextActionInput> = {}) => nextCostVerifyAction({ status: complete, state: "ESTIMATOR_REVIEW", roles: { rep: false, estimator: false, manager: true }, dirty: false, signoff: blockers.signoff, costAcknowledged: true, costNeedsMark: false, amountChanged: false, serverIncomplete: false, approvalBlockers: approvalBlockers(blockers), ...o });

/** The condition the Approve button enforced BEFORE this change (page.tsx), restated: the unified list must block in exactly the same cases. */
const oldDisabled = (i: ApprovalBlockerInput) => i.signoff !== "current" || i.dirty || i.notReadyReasons !== null || i.costingOpen || i.baselineExceptionRequired || (i.blockingLabels?.length ?? 0) > 0;

describe("approvalBlockers blocks in EXACTLY the cases the Approve button always did (no gate added or removed)", () => {
  it("over every combination of the gates", () => {
    for (const signoff of ["none", "current", "stale"] as const) for (const dirty of [false, true]) for (const nr of [null, [], ["Open mapping"]]) for (const costingOpen of [false, true]) for (const bx of [false, true]) for (const blocking of [[], ["M75"]]) {
      const i: ApprovalBlockerInput = { signoff, dirty, notReadyReasons: nr, costingOpen, baselineExceptionRequired: bx, blockingLabels: blocking };
      expect(approvalBlockers(i).length > 0, JSON.stringify(i)).toBe(oldDisabled(i));
    }
  });
});

describe("the banner never says ready while Approve is blocked", () => {
  it("over every combination: id 'approve' appears only when the blocker list is empty", () => {
    for (const signoff of ["none", "current", "stale"] as const) for (const dirty of [false, true]) for (const nr of [null, ["Open mapping"]]) for (const costingOpen of [false, true]) for (const bx of [false, true]) for (const blocking of [[], ["M75"]]) for (const manager of [true, false]) {
      const i: ApprovalBlockerInput = { signoff, dirty, notReadyReasons: nr, costingOpen, costingReason: "a supplier cost is unresolved", baselineExceptionRequired: bx, baselineExceptionItems: ["M75 feed system"], blockingLabels: blocking };
      const a = banner(i, { dirty, roles: { rep: false, estimator: !manager, manager }, serverIncomplete: costingOpen, readinessBlocked: nr ? ["Open mapping"] : [] });
      if (a.id === "approve") expect(approvalBlockers(i), JSON.stringify(i)).toEqual([]);
      if (approvalBlockers(i).length > 0) expect(a.headline, JSON.stringify(i)).not.toMatch(/^Ready for/);
    }
  });
  it("a Manager with a REQUIRED baseline exception (everything else clean): 'Baseline exception required before approval', naming the items", () => {
    const a = banner({ ...clean, baselineExceptionRequired: true, baselineExceptionItems: ["M75 feed distribution system", "PP penning"] });
    expect(a.id).toBe("approval-blocked");
    expect(a.headline).toBe("Baseline exception required before approval");
    expect(a.detail).toMatch(/M75 feed distribution system, PP penning/);
    expect(a.detail).toMatch(/Approve with the recorded exception/);
    expect(a.tone).toBe("warning");
    expect(a.outstanding.join(" ")).toMatch(/baseline exception is required/);
  });
  it("an Estimator sees the same blocker phrased for the Manager, never 'Ready for Manager approval'", () => {
    const a = banner({ ...clean, baselineExceptionRequired: true, baselineExceptionItems: ["PP penning"] }, { roles: { rep: false, estimator: true, manager: false } });
    expect(a.headline).toBe("Baseline exception required before Manager approval");
    expect(a.detail).toMatch(/The Manager approves it with a recorded exception/);
  });
  it("unmapped products no exception can cover: a mapping is required, naming them", () => {
    const a = banner({ ...clean, blockingLabels: ["Feeder X"] });
    expect(a.headline).toBe("Library mapping required before approval");
    expect(a.detail).toMatch(/Feeder X needs an active library mapping/);
  });
  it("with nothing blocking, a current sign-off IS ready (Manager and Estimator wording unchanged)", () => {
    expect(banner(clean).headline).toBe("Ready for your approval");
    expect(banner(clean, { roles: { rep: false, estimator: true, manager: false } }).headline).toBe("Ready for Manager approval");
    expect(banner(clean).id).toBe("approve");
  });
  it("a missing / stale sign-off is never 'ready' and is unchanged", () => {
    expect(banner({ ...clean, signoff: "none" }).id).not.toBe("approve");
    expect(banner({ ...clean, signoff: "stale" }).id).not.toBe("approve");
    expect(banner({ ...clean, signoff: "none" }, { roles: { rep: false, estimator: true, manager: false } }).id).toBe("signoff");
  });
  it("the blockers name each outstanding item in plain language", () => {
    const t = approvalBlockers({ signoff: "stale", dirty: true, notReadyReasons: ["3 lines unmapped", "x"], costingOpen: true, costingReason: "SKU A has no cost.", baselineExceptionRequired: true, baselineExceptionItems: ["PP penning"], blockingLabels: ["Feeder X", "Feeder Y"] }).map((b) => b.text);
    expect(t).toEqual([
      "The Estimator sign-off no longer matches the current quotation", "There are unsaved edits: approval applies to the saved quotation", "The quotation is not ready: 3 lines unmapped (+1 more)",
      "Costing is incomplete: SKU A has no cost", "A baseline exception is required before approval (PP penning)", "Feeder X, Feeder Y need an active library mapping before approval",
    ]);
  });
});
