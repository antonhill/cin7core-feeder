import { describe, expect, it } from "vitest";
import { computeStages, type StageInput } from "../stages";
import { PHASE_IDS, PHASE_LABEL, PHASE_STAGES, phaseOfStage, phaseViews, representativeStage } from "../phases";

const base: StageInput = { state: "REP_DRAFT", revision: 1, ready: false, customerSelected: false, confirmed: false, signedOff: false, commercial: null, hasDocument: false, requiresAcceptance: true, projectLinked: false };
const rep = (i: Partial<StageInput>, p: 1 | 2 | 3 | 4) => representativeStage(p, computeStages({ ...base, ...i }));

describe("four user-facing phases map the six existing stages", () => {
  it("labels and grouping are fixed: 1 -> Configure & Submit, 2 -> Cost & Verify, 3 -> Approve or Return, 4+5+6 -> Customer & Handover", () => {
    expect(PHASE_IDS.map((p) => PHASE_LABEL[p])).toEqual(["Configure & Submit", "Cost & Verify", "Approve or Return", "Customer & Handover"]);
    expect(([1, 2, 3, 4, 5, 6] as const).map(phaseOfStage)).toEqual([1, 2, 3, 4, 4, 4]);
    expect(Object.values(PHASE_STAGES).flat()).toEqual([1, 2, 3, 4, 5, 6]); // every stage is in exactly one phase, in order
  });
  it("phases 1-3 stand for their own stage", () => {
    const s = computeStages(base);
    expect([1, 2, 3].map((p) => representativeStage(p as 1 | 2 | 3, s))).toEqual([1, 2, 3]);
  });
  it("Customer & Handover is the first unfinished of stages 4-6", () => {
    const fin: Partial<StageInput> = { state: "MANAGER_APPROVED_FINAL", ready: true, customerSelected: true, signedOff: true };
    expect(rep({ ...fin, commercial: "APPROVED_INTERNALLY" }, 4)).toBe(4); // approved, nothing issued yet
    expect(rep({ ...fin, commercial: "SENT_TO_CUSTOMER", hasDocument: true }, 4)).toBe(5); // sent: waiting for the customer
    expect(rep({ ...fin, commercial: "ACCEPTANCE_PENDING_VERIFICATION", hasDocument: true }, 4)).toBe(5);
    expect(rep({ ...fin, commercial: "CUSTOMER_ACCEPTED", hasDocument: true }, 4)).toBe(6); // accepted: the Manager creates the Project
    expect(rep({ ...fin, commercial: "CUSTOMER_DECLINED", hasDocument: true }, 4)).toBe(5); // returned stays on acceptance
  });
  it("a created Project completes the phase and it stands for Project handover", () => {
    const s = computeStages({ ...base, state: "MANAGER_APPROVED_FINAL", ready: true, customerSelected: true, signedOff: true, commercial: "CUSTOMER_ACCEPTED", hasDocument: true, projectLinked: true });
    expect(representativeStage(4, s)).toBe(6);
    expect(s.find((x) => x.id === 6)!.status).toBe("COMPLETE");
  });
  it("a quotation approved before customer acceptance existed (grandfathered) goes straight to handover", () => {
    expect(rep({ state: "MANAGER_APPROVED_FINAL", ready: true, customerSelected: true, signedOff: true, requiresAcceptance: false, commercial: "APPROVED_INTERNALLY" }, 4)).toBe(6);
  });
  it("while the commercial records load, the phase shows loading (never an earlier-looking guess)", () => {
    const s = computeStages({ ...base, state: "MANAGER_APPROVED_FINAL", ready: true, customerSelected: true, signedOff: true, loading: true });
    expect(s.find((x) => x.id === representativeStage(4, s))!.status).toBe("LOADING");
  });
  it("before approval the whole phase is not available and stands for stage 4", () => {
    const s = computeStages({ ...base, state: "ESTIMATOR_REVIEW", ready: true, customerSelected: true });
    expect(representativeStage(4, s)).toBe(4);
    expect(s.find((x) => x.id === 4)!.status).toBe("NOT_AVAILABLE");
  });
  it("phaseViews carries label, owner and the grouped stage ids; computeStages is not touched (still six stages)", () => {
    const s = computeStages(base);
    expect(s).toHaveLength(6);
    const v = phaseViews(s);
    expect(v.map((p) => [p.label, p.owner])).toEqual([["Configure & Submit", "Rep"], ["Cost & Verify", "Estimator"], ["Approve or Return", "Manager"], ["Customer & Handover", "Rep and Manager"]]);
    expect(v[3].stageIds).toEqual([4, 5, 6]);
  });
});
