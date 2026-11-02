import { describe, expect, it } from "vitest";
import { computeStages, currentStage, parseStage, type StageInput } from "../stages";

const base: StageInput = { state: "REP_DRAFT", revision: 1, ready: false, customerSelected: false, confirmed: false, signedOff: false, commercial: null, hasDocument: false, requiresAcceptance: true, projectLinked: false };
const st = (over: Partial<StageInput>) => computeStages({ ...base, ...over });
const row = (over: Partial<StageInput>) => st(over).map((s) => `${s.id}:${s.status}`).join(" ");

describe("six stages derived from existing state and evidence", () => {
  it("a new draft: configuration in progress, everything else not started / not available", () => {
    expect(row({})).toBe("1:IN_PROGRESS 2:NOT_STARTED 3:NOT_STARTED 4:NOT_AVAILABLE 5:NOT_AVAILABLE 6:NOT_AVAILABLE");
    expect(currentStage(st({}))).toBe(1);
    expect(st({})[0].next).toMatch(/select the Cin7 customer/i);
  });
  it("ready with a customer: configuration complete and the Rep's confirmation + handoff is the next action", () => {
    const s = st({ ready: true, customerSelected: true });
    expect(row({ ready: true, customerSelected: true })).toMatch(/^1:COMPLETE 2:AWAITING_ACTION 3:NOT_STARTED/);
    expect(s[1].next).toMatch(/pre-approval price confirmation/);
    expect(currentStage(s)).toBe(2);
  });
  it("with the Estimator: stage 2 awaits the Estimator; after sign-off stage 3 awaits the Manager", () => {
    expect(row({ state: "ESTIMATOR_REVIEW", ready: true, customerSelected: true, confirmed: true })).toMatch(/^1:COMPLETE 2:AWAITING_ACTION 3:NOT_STARTED/);
    const s = st({ state: "ESTIMATOR_REVIEW", ready: true, customerSelected: true, confirmed: true, signedOff: true });
    expect(s.map((x) => x.status).slice(0, 3)).toEqual(["COMPLETE", "COMPLETE", "AWAITING_ACTION"]);
    expect(s[2].next).toMatch(/Manager: approve, return to the Estimator/);
    expect(currentStage(s)).toBe(3);
  });
  it("returned to the Rep (new revision): stage 1 shows RETURNED and the next action", () => {
    const s = st({ revision: 2, ready: true, customerSelected: true });
    expect(s[0].status).toBe("RETURNED"); expect(s[0].statusLabel).toBe("Returned"); expect(s[0].next).toMatch(/reconfirm/);
    expect(currentStage(s)).toBe(1);
  });
  it("approved, nothing issued yet: stage 3 complete, stage 4 ready to issue the PDF, 5 awaiting issue, 6 not available", () => {
    const s = st({ state: "MANAGER_APPROVED_FINAL", ready: true, customerSelected: true, confirmed: true, signedOff: true, commercial: "APPROVED_INTERNALLY" });
    expect(s.map((x) => x.status)).toEqual(["COMPLETE", "COMPLETE", "COMPLETE", "AWAITING_ACTION", "NOT_STARTED", "NOT_AVAILABLE"]);
    expect(s[3].summary).toMatch(/ready to issue the customer PDF/i); expect(s[4].summary).toBe("Awaiting quotation issue.");
    expect(currentStage(s)).toBe(4);
  });
  it("issued but not sent: stage 4 asks for the send; sent: stage 5 awaits the customer's response", () => {
    const f = { state: "MANAGER_APPROVED_FINAL" as const, ready: true, customerSelected: true, confirmed: true, signedOff: true };
    expect(st({ ...f, commercial: "APPROVED_INTERNALLY", hasDocument: true })[3].next).toMatch(/send it/);
    const s = st({ ...f, commercial: "SENT_TO_CUSTOMER", hasDocument: true });
    expect([s[3].status, s[4].status, s[5].status]).toEqual(["COMPLETE", "AWAITING_ACTION", "NOT_AVAILABLE"]);
    expect(currentStage(s)).toBe(5);
  });
  it("customer accepted: stage 5 complete and the Project is the next action; Manager approval alone NEVER opens stage 6", () => {
    const f = { state: "MANAGER_APPROVED_FINAL" as const, ready: true, customerSelected: true, confirmed: true, signedOff: true, hasDocument: true };
    const acc = st({ ...f, commercial: "CUSTOMER_ACCEPTED" });
    expect([acc[4].status, acc[5].status]).toEqual(["COMPLETE", "AWAITING_ACTION"]);
    for (const c of ["APPROVED_INTERNALLY", "SENT_TO_CUSTOMER", "CUSTOMER_DECLINED", "CHANGES_REQUESTED"] as const) expect(st({ ...f, commercial: c })[5].status, c).toBe("NOT_AVAILABLE");
    expect(st({ ...f, commercial: null })[5].status).toBe("NOT_AVAILABLE");
  });
  it("declined / changes requested: stage 5 is RETURNED with the next action", () => {
    const f = { state: "MANAGER_APPROVED_FINAL" as const, ready: true, customerSelected: true, confirmed: true, signedOff: true, hasDocument: true };
    for (const c of ["CUSTOMER_DECLINED", "CHANGES_REQUESTED"] as const) { const s = st({ ...f, commercial: c }); expect(s[4].status).toBe("RETURNED"); expect(s[4].next).toMatch(/revised quotation/); }
  });
  it("grandfathered (approved before customer acceptance existed): stages 4-5 are NOT_REQUIRED and the Project is eligible; a linked project completes stage 6", () => {
    const f = { state: "MANAGER_APPROVED_FINAL" as const, ready: true, customerSelected: true, confirmed: true, signedOff: true, requiresAcceptance: false, commercial: "APPROVED_INTERNALLY" as const };
    const s = st(f);
    expect(s.map((x) => x.status)).toEqual(["COMPLETE", "COMPLETE", "COMPLETE", "NOT_REQUIRED", "NOT_REQUIRED", "AWAITING_ACTION"]);
    expect(st({ ...f, projectLinked: true })[5].status).toBe("COMPLETE");
    expect(currentStage(st({ ...f, projectLinked: true }))).toBe(6);
  });
  it("a project link completes stage 6 for a new quotation too", () => {
    const s = st({ state: "MANAGER_APPROVED_FINAL", ready: true, customerSelected: true, signedOff: true, commercial: "CUSTOMER_ACCEPTED", hasDocument: true, projectLinked: true });
    expect(s.every((x) => x.status === "COMPLETE")).toBe(true);
  });
  it("labels are the six agreed names; deep-link parsing accepts only 1-6", () => {
    expect(st({}).map((s) => s.label)).toEqual(["Configuration", "Costing & Estimator Review", "Manager Approval", "Customer Quotation", "Customer Acceptance", "Project Handover"]);
    expect(parseStage("4")).toBe(4); for (const bad of ["0", "7", "x", "", null, undefined, "2.5"]) expect(parseStage(bad as never)).toBeNull();
  });
  it("a customer acceptance that arrived by email waits for verification: stage 5 awaits action, stage 6 stays closed with the reason; a rejected one is RETURNED; only a verified one opens stage 6", () => {
    const f = { state: "MANAGER_APPROVED_FINAL" as const, ready: true, customerSelected: true, confirmed: true, signedOff: true, hasDocument: true };
    const pend = st({ ...f, commercial: "ACCEPTANCE_PENDING_VERIFICATION" });
    expect([pend[3].status, pend[4].status, pend[5].status]).toEqual(["COMPLETE", "AWAITING_ACTION", "NOT_AVAILABLE"]);
    expect(pend[4].next).toMatch(/verify or reject/); expect(pend[5].summary).toMatch(/emailed acceptance to be verified/);
    expect(currentStage(pend)).toBe(5);
    const rej = st({ ...f, commercial: "ACCEPTANCE_REJECTED" });
    expect([rej[4].status, rej[5].status]).toEqual(["RETURNED", "NOT_AVAILABLE"]); expect(rej[4].summary).toMatch(/rejected during verification/);
    const ok = st({ ...f, commercial: "CUSTOMER_ACCEPTED" });
    expect([ok[4].status, ok[5].status]).toEqual(["COMPLETE", "AWAITING_ACTION"]); expect(ok[4].summary).toMatch(/verified/);
  });
  it("an expired or withdrawn emailed link is stated at stage 5 with the way forward", () => {
    const f = { state: "MANAGER_APPROVED_FINAL" as const, ready: true, customerSelected: true, confirmed: true, signedOff: true, hasDocument: true, commercial: "SENT_TO_CUSTOMER" as const };
    expect(st({ ...f, linkState: "EXPIRED" })[4].summary).toMatch(/link has expired/);
    expect(st({ ...f, linkState: "REVOKED" })[4].summary).toMatch(/link was withdrawn/);
    expect(st({ ...f, linkState: "ACTIVE" })[4].summary).toBe("Waiting for the customer's response.");
    expect(st({ ...f, linkState: "EXPIRED" })[4].next).toMatch(/send the quotation again/);
  });
});
