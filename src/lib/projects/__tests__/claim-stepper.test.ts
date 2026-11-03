import { describe, expect, it } from "vitest";
import { claimSteps } from "../claim-stepper";

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
  it("a closed no-write claim (cancelled or confirmed-failed) completes nothing", () => {
    for (const status of ["CANCELLED_BEFORE_WRITE", "FAILED_CONFIRMED_NO_WRITE"]) expect(st({ chosenCount: 0, preview: "NONE", savedClaimStatus: status })).toEqual(["next", "todo", "todo", "todo"]);
  });
  it("submit step text depends on whether the viewer can submit", () => {
    expect(claimSteps({ chosenCount: 0, preview: "NONE", savedClaimStatus: "DRAFT", canSubmit: true })[3].text).toBe("Next: use Submit on the draft");
    expect(claimSteps({ chosenCount: 0, preview: "NONE", savedClaimStatus: "DRAFT", canSubmit: false })[3].text).toBe("Needs someone with edit access");
  });
  it("a preview without a selection is not complete", () => {
    expect(st({ chosenCount: 0, preview: "CURRENT", savedClaimStatus: null })[1]).not.toBe("done");
  });
});
