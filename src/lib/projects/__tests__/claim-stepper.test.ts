import { describe, expect, it } from "vitest";
import { claimSteps } from "../claim-stepper";
import { nothingClaimableReasons } from "../nothing-claimable";

const st = (i: Parameters<typeof claimSteps>[0]) => claimSteps(i).map((s) => s.status);

describe("claimSteps: complete only from state, never because visited", () => {
  it("nothing selected: step 1 is next, the rest are not done", () => {
    expect(st({ chosenCount: 0, preview: "NONE", savedClaimStatus: null })).toEqual(["next", "todo", "todo", "todo"]);
  });
  it("stages selected, no preview: select done, preview next", () => {
    expect(st({ chosenCount: 2, preview: "NONE", savedClaimStatus: null })).toEqual(["done", "next", "todo", "todo"]);
    expect(claimSteps({ chosenCount: 2, preview: "NONE", savedClaimStatus: null })[0].text).toBe("2 selected");
  });
  it("a current preview completes step 2; a STALE preview is not complete and needs attention", () => {
    expect(st({ chosenCount: 1, preview: "CURRENT", savedClaimStatus: null })).toEqual(["done", "done", "next", "todo"]);
    const stale = claimSteps({ chosenCount: 1, preview: "STALE", savedClaimStatus: null });
    expect(stale.map((s) => s.status)).toEqual(["done", "attention", "todo", "todo"]);
    expect(stale[1].text).toBe("Out of date");
  });
  it("a saved draft completes 1-3; submit is next until the claim is out of DRAFT", () => {
    expect(st({ chosenCount: 0, preview: "NONE", savedClaimStatus: "DRAFT" })).toEqual(["done", "done", "done", "next"]);
    expect(st({ chosenCount: 0, preview: "NONE", savedClaimStatus: "READY_FOR_APPROVAL" })).toEqual(["done", "done", "done", "done"]);
    expect(st({ chosenCount: 0, preview: "NONE", savedClaimStatus: "APPROVED" })).toEqual(["done", "done", "done", "done"]);
  });
  it("a cancelled saved draft completes nothing", () => {
    expect(st({ chosenCount: 0, preview: "NONE", savedClaimStatus: "CANCELLED_BEFORE_WRITE" })).toEqual(["next", "todo", "todo", "todo"]);
  });
  it("a preview without a selection is not complete", () => {
    expect(st({ chosenCount: 0, preview: "CURRENT", savedClaimStatus: null })[1]).not.toBe("done");
  });
});

const stage = (approvedBps: number, claimableCents: number, remainingCents: number) => ({ approvedBps, claimableCents, remainingCents });
const base = { scheduleBalanced: true, uncertainClaimBlocking: false, isAdmin: true };

describe("nothingClaimableReasons", () => {
  it("is null when any stage is claimable", () => {
    expect(nothingClaimableReasons({ ...base, stages: [stage(0, 0, 100), stage(5000, 50, 100)] })).toBeNull();
  });
  it("zero approved progress: admin is told to Approve commercial progress, a member is told who must", () => {
    const a = nothingClaimableReasons({ ...base, stages: [stage(0, 0, 100)] })!;
    expect(a[0].text).toMatch(/No stage has approved commercial progress\. Use Approve commercial progress/);
    expect(a[0].tab).toBe("stages");
    const m = nothingClaimableReasons({ ...base, isAdmin: false, stages: [stage(0, 0, 100)] })!;
    expect(m[0].text).toMatch(/owner or admin must approve/);
  });
  it("approved progress already billed", () => {
    const r = nothingClaimableReasons({ ...base, stages: [stage(10000, 0, 40)] })!;
    expect(r[0].text).toMatch(/already billed or committed/);
  });
  it("fully committed stages", () => {
    expect(nothingClaimableReasons({ ...base, stages: [stage(10000, 0, 0)] })![0].text).toMatch(/fully billed or committed/);
  });
  it("unbalanced schedule and uncertain claim come first and are named", () => {
    const r = nothingClaimableReasons({ ...base, scheduleBalanced: false, uncertainClaimBlocking: true, stages: [stage(0, 0, 100)] })!;
    expect(r[0].text).toMatch(/do not reconcile/);
    expect(r[1].text).toMatch(/uncertain Cin7 outcome/);
    expect(r.length).toBe(3);
  });
  it("no stages", () => {
    expect(nothingClaimableReasons({ ...base, stages: [] })![0].text).toMatch(/no billing stages/);
  });
});
