import { describe, expect, it } from "vitest";
import { nextActionText, phase1State, phase3State, phaseBadge, supportingDetailLabel, totalCaption } from "../[id]/phase-ux-model";

const f = (over: Partial<Parameters<typeof phaseBadge>[1]> = {}) => ({ state: "REP_DRAFT", revision: 1, final: false, signedOffCurrent: false, repReady: false, viewerIsRep: true, ...over });

describe("the badge describes the phase being viewed", () => {
  it("a returned quotation is 'returned' on phases 1 and 3 only; Phase 4 says it is not approved yet", () => {
    expect(phaseBadge(1, f({ revision: 2 })).text).toBe("RETURNED TO THE REP");
    expect(phaseBadge(3, f({ revision: 2 })).text).toBe("RETURNED TO THE REP");
    expect(phaseBadge(4, f({ revision: 2 })).text).toBe("NOT APPROVED YET");
  });
  it("Phase 1: ready to submit only for the Rep with a complete draft", () => {
    expect(phaseBadge(1, f({ repReady: true })).text).toBe("READY TO SUBMIT");
    expect(phaseBadge(1, f({ repReady: true, viewerIsRep: false })).text).toBe("WITH THE REP");
    expect(phaseBadge(1, f()).text).toBe("WITH THE REP");
  });
  it("Phase 3 says what the decision waits for; an approved quotation is approved everywhere", () => {
    expect(phaseBadge(3, f({ state: "ESTIMATOR_REVIEW" })).text).toBe("AWAITING ESTIMATOR SIGN-OFF");
    expect(phaseBadge(3, f({ state: "ESTIMATOR_REVIEW", signedOffCurrent: true })).text).toBe("READY FOR THE MANAGER'S DECISION");
    for (const s of [1, 3, 4, 5, 6] as const) expect(phaseBadge(s, f({ state: "MANAGER_APPROVED_FINAL", final: true })).text).toBe("APPROVED");
  });
});

describe("state wording is a state, never a second instruction", () => {
  it("phase 1 and phase 3 states carry no 'Next' or 'must'", () => {
    for (const x of [f(), f({ revision: 2 }), f({ state: "ESTIMATOR_REVIEW" }), f({ state: "ESTIMATOR_REVIEW", signedOffCurrent: true }), f({ final: true })]) {
      expect(phase1State(x)).not.toMatch(/\bNext\b|\bmust\b/);
      expect(phase3State(x)).not.toMatch(/\bNext\b|\bmust\b/);
    }
  });
});

describe("amounts are labelled by what they are", () => {
  it("never a contract value before approval; indicative while lines await the Estimator", () => {
    expect(totalCaption({ final: true, awaitingLines: 0, incomplete: false, confirmed: true }).note).toBeNull();
    expect(totalCaption({ final: false, awaitingLines: 2, incomplete: true, confirmed: false }).label).toBe("Indicative total (2 lines await the Estimator)");
    expect(totalCaption({ final: false, awaitingLines: 0, incomplete: true, confirmed: false }).label).toBe("Partial total (ex VAT)");
    expect(totalCaption({ final: false, awaitingLines: 0, incomplete: false, confirmed: false }).note).toBe("Not a contract value.");
  });
});

describe("the supporting-detail heading and the next action", () => {
  it("a role that cannot see costs is never told cost evidence exists", () => {
    expect(supportingDetailLabel(false)).not.toMatch(/evidence|cost|margin|override/i);
    expect(supportingDetailLabel(true)).toMatch(/pricing evidence/);
  });
  it("the next action leads with the action and keeps the explanation secondary", () => {
    expect(nextActionText({ summary: "Nothing is left for you.", next: "Rep: submit it." })).toEqual({ headline: "Rep: submit it.", detail: "Nothing is left for you." });
    expect(nextActionText({ summary: "All done." })).toEqual({ headline: "All done.", detail: null });
    expect(nextActionText(null)).toBeNull();
  });
});
