import { describe, expect, it } from "vitest";
import { deriveStage2Steps, stage2StepIds, type Stage2Input } from "../stage2-steps";

const line = (over: Record<string, unknown> = {}) => ({ basis: "system_calculated", exclusionReason: null, inputRequired: null, overrideState: "none", overrideReason: null, ...over });
const ok: Stage2Input = {
  canViewCommercials: true, state: "REP_DRAFT", calcValid: true, lines: [line(), line()],
  readiness: { state: "READY", reasons: [], missingMappings: 0 },
  budget: { incomplete: false, estimatedCost: 1000, marginPct: 25, lines: [{ status: "priced" }], charges: [{ label: "Delivery", status: "entered" }] },
  blankExclusionCount: 0, incompleteCostOverrideCount: 0, blankPriceReasonCount: 0, totalAvailable: true, confirmedRecorded: false, signoff: "none", dirty: false,
};
const by = (i: Stage2Input) => Object.fromEntries(deriveStage2Steps(i).map((s) => [s.id, s.status]));
const note = (i: Stage2Input, id: string) => deriveStage2Steps(i).find((s) => s.id === id)?.note;

describe("deriveStage2Steps (UX-006b): statuses come from loaded data only", () => {
  it("a viewer without cost visibility has THREE steps and the cost step does not exist for them", () => {
    expect(stage2StepIds(false)).toEqual(["lines", "charges", "handoff"]);
    expect(stage2StepIds(true)).toEqual(["lines", "charges", "cost", "handoff"]);
    const steps = deriveStage2Steps({ ...ok, canViewCommercials: false });
    expect(steps.map((s) => s.id)).toEqual(["lines", "charges", "handoff"]);
    expect(JSON.stringify(steps)).not.toMatch(/cost|margin/i); // no label, status or note names cost data
  });
  it("lines: complete when every mapping, quantity and override reason is settled", () => {
    expect(by(ok).lines).toBe("complete");
  });
  it("lines: a missing mapping, a pending quantity and an override without a reason each need attention, with a count", () => {
    expect(by({ ...ok, readiness: { ...ok.readiness, missingMappings: 2 } }).lines).toBe("attention");
    expect(note({ ...ok, readiness: { ...ok.readiness, missingMappings: 2 } }, "lines")).toBe("2 mappings to confirm");
    expect(note({ ...ok, lines: [line({ inputRequired: "Enter the feeder quantity" })] }, "lines")).toBe("1 quantity to enter");
    expect(note({ ...ok, lines: [line({ overrideState: "manual_override", overrideReason: null })] }, "lines")).toBe("1 override reason missing");
  });
  it("lines: an excluded line or a line that is not selected is not a pending quantity", () => {
    expect(by({ ...ok, lines: [line({ inputRequired: "x", exclusionReason: "Customer supplies" }), line({ basis: "not_selected", inputRequired: "x" })] }).lines).toBe("complete");
  });
  it("before Stage 1 is valid there is nothing to decide: steps 1 to 3 are Not complete and point back to Stage 1", () => {
    const s = by({ ...ok, calcValid: false, budget: null });
    expect([s.lines, s.charges, s.cost]).toEqual(["incomplete", "incomplete", "incomplete"]);
    expect(note({ ...ok, calcValid: false, budget: null }, "lines")).toBe("Finish the Stage 1 configuration first");
  });
  it("charges: a blank exclusion reason, a blank manual-price reason, an unpriced line and an unentered charge each need attention", () => {
    expect(by(ok).charges).toBe("complete");
    expect(note({ ...ok, blankExclusionCount: 1 }, "charges")).toBe("1 excluded item needs a reason");
    expect(note({ ...ok, blankPriceReasonCount: 2 }, "charges")).toBe("2 manual prices need a reason");
    expect(note({ ...ok, budget: { ...ok.budget!, lines: [{ status: "supplier_quote_required" }] } }, "charges")).toBe("1 line needs a price");
    expect(note({ ...ok, budget: { ...ok.budget!, charges: [{ label: "Delivery", status: "required" }] } }, "charges")).toBe("1 charge not entered");
  });
  it("cost: a complete estimate on a draft is only Review (Cin7 cost capture is not known here), Complete once frozen; partial, no margin or an incomplete override needs attention", () => {
    expect(by(ok).cost).toBe("review");
    expect(note(ok, "cost")).toBe("Cin7 cost capture is checked in the Cost panel");
    expect(by({ ...ok, state: "MANAGER_APPROVED_FINAL" }).cost).toBe("complete");
    expect(by({ ...ok, budget: { ...ok.budget!, incomplete: true } }).cost).toBe("attention");
    expect(by({ ...ok, budget: { ...ok.budget!, marginPct: null } }).cost).toBe("attention");
    expect(note({ ...ok, incompleteCostOverrideCount: 1 }, "cost")).toBe("1 cost override is incomplete");
    expect(note({ ...ok, budget: null }, "cost")).toBe("Cost figures are not available yet");
  });
  it("handoff, Rep draft: not READY or no total needs attention; READY is Not complete (ready for the confirmation), never Complete", () => {
    expect(by({ ...ok, readiness: { state: "BLOCKED", reasons: ["x"], missingMappings: 0 } }).handoff).toBe("attention");
    expect(by({ ...ok, totalAvailable: false }).handoff).toBe("attention");
    expect(by(ok).handoff).toBe("incomplete");
    expect(note(ok, "handoff")).toBe("Ready for the price confirmation");
  });
  it("handoff, Estimator review: Complete only for a sign-off on THIS content; stale needs attention; unsigned is Not complete", () => {
    const er = { ...ok, state: "ESTIMATOR_REVIEW" as const };
    expect(by({ ...er, signoff: "current" }).handoff).toBe("complete");
    expect(by({ ...er, signoff: "stale" }).handoff).toBe("attention");
    expect(by({ ...er, signoff: "none" }).handoff).toBe("incomplete");
    expect(by({ ...er, signoff: "none", readiness: { state: "BLOCKED", reasons: ["x"], missingMappings: 0 } }).handoff).toBe("attention");
  });
  it("handoff: a current sign-off with unsaved edits needs attention (saving would make it stale)", () => {
    const er = { ...ok, state: "ESTIMATOR_REVIEW" as const, signoff: "current" as const };
    expect(by({ ...er, dirty: true }).handoff).toBe("attention");
    expect(note({ ...er, dirty: true }, "handoff")).toBe("Unsaved edits: saving makes the sign-off stale");
    expect(by(er).handoff).toBe("complete");
  });
  it("handoff, approved: Complete", () => { expect(by({ ...ok, state: "MANAGER_APPROVED_FINAL" }).handoff).toBe("complete"); });
});
