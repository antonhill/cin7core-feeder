import { describe, expect, it } from "vitest";
import { claimNextStep } from "../claim-next-step";

describe("UAT-015 claim next-step line", () => {
  it("names the real next action for every claim state", () => {
    expect(claimNextStep({ status: "DRAFT", cin7Kind: "NOT_POSTED" })).toMatch(/Submit/);
    expect(claimNextStep({ status: "READY_FOR_APPROVAL", cin7Kind: "NOT_POSTED", stageRole: "MANAGER" })).toMatch(/manager.*Approvals/);
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "NOT_POSTED" })).toMatch(/post it to Cin7/);
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "DRAFT_CREATED" })).toMatch(/authorise it in Cin7/);
    expect(claimNextStep({ status: "RECONCILED", cin7Kind: "AUTHORISED" })).toMatch(/authorised/);
  });
  it("an uncertain posting always says reconcile first, never retry", () => {
    for (const c of [{ status: "FAILED_UNCERTAIN", cin7Kind: "UNCERTAIN" as const }, { status: "APPROVED", cin7Kind: "UNCERTAIN" as const }]) expect(claimNextStep(c)).toMatch(/[Rr]econcile/);
    expect(claimNextStep({ status: "APPROVED", cin7Kind: "POSTING" })).toMatch(/Do not retry/);
  });
  it("closed claims say nothing was sent", () => {
    expect(claimNextStep({ status: "CANCELLED_BEFORE_WRITE", cin7Kind: "NOT_POSTED" })).toMatch(/nothing was sent/);
  });
});
