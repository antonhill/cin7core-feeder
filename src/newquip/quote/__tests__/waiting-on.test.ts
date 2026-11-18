import { describe, expect, it } from "vitest";
import { waitingOn } from "../workflow";

describe("quote list 'Waiting on / next' cue (from existing fields only)", () => {
  it("names the role that has the quotation next", () => {
    expect(waitingOn({ state: "REP_DRAFT", revision: 1, signed_off: false })).toBe("Rep: preparing (revision 1)");
    expect(waitingOn({ state: "REP_DRAFT", revision: 3, signed_off: false })).toBe("Rep: returned (revision 3) - make the corrections");
    expect(waitingOn({ state: "ESTIMATOR_REVIEW", revision: 1, signed_off: false })).toBe("Estimator: review & sign-off");
    expect(waitingOn({ state: "ESTIMATOR_REVIEW", revision: 1, signed_off: true })).toBe("Manager: approval");
    expect(waitingOn({ state: "MANAGER_APPROVED_FINAL", revision: 2, signed_off: true })).toBe("Approved");
  });
});
