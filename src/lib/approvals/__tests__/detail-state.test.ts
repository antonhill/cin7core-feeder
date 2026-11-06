import { describe, expect, it } from "vitest";
import { applyDecision, showDecisionPanel } from "../detail-state";

const pending = { request: { status: "PENDING", id: "r" }, can: { decide: true, withdraw: true, reassign: true, needsOverride: true, returnToEstimator: true } };

describe("UAT-023: decision controls disappear as soon as the decision is recorded", () => {
  it("a pending request the viewer may decide shows the panel", () => {
    expect(showDecisionPanel(pending)).toBe(true);
  });
  it("after an override approval the page is APPROVED and no control remains, even before any reload", () => {
    const after = applyDecision(pending, { status: "APPROVED", id: "r" });
    expect(after.request.status).toBe("APPROVED");
    expect(after.can).toEqual({ decide: false, withdraw: false, reassign: false, needsOverride: false, returnToEstimator: false });
    expect(showDecisionPanel(after)).toBe(false);
  });
  it("a non-pending request never shows the panel even if a stale 'can' says decide", () => {
    expect(showDecisionPanel({ request: { status: "APPROVED" }, can: pending.can })).toBe(false);
  });
  it("does not mutate the previous state", () => {
    const copy = JSON.stringify(pending);
    applyDecision(pending, { status: "REJECTED", id: "r" });
    expect(JSON.stringify(pending)).toBe(copy);
  });
});
