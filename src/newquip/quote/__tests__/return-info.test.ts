import { describe, expect, it } from "vitest";
import {
  candidateFromActivity, candidateFromApproval, latestReturnInfo, returnInfoForViewer, returnRoleOf, CONFIRMATION_WITHDRAWN_ACTION, NEUTRAL_REASON, RETURN_RECORD_ACTION,
  type ReturnCandidate,
} from "../return-info";

const rep = { state: "REP_DRAFT", revision: 2, estimator_signoff_hash: null as string | null };
const rec = (o: Partial<ReturnCandidate> = {}): ReturnCandidate => ({ kind: "RETURN", reason: "Gate width is wrong", byEmail: "est@nq", byRole: "estimator", at: "2026-11-03T08:00:00.000Z", destination: "REP", source: "RECORD", revision: 2, ...o });
const row = (detail: Record<string, unknown>, created_at = "2026-11-03T08:00:00.000Z", action = RETURN_RECORD_ACTION) => ({ action, actor_email: "owner@nq", detail, created_at });

describe("latestReturnInfo: which return explains where the quotation is NOW", () => {
  it("returns reason, actor, role, time, destination for the current revision (no internal fields)", () => {
    expect(latestReturnInfo(rep, [rec()])).toEqual({ kind: "RETURN", reason: "Gate width is wrong", byEmail: "est@nq", byRole: "estimator", at: "2026-11-03T08:00:00.000Z", destination: "REP", source: "RECORD" });
  });
  it("nothing to show for a first draft, or once the quotation moved on", () => {
    expect(latestReturnInfo({ ...rep, revision: 1 }, [rec({ revision: null })])).toBeNull();
    expect(latestReturnInfo({ state: "ESTIMATOR_REVIEW", revision: 2, estimator_signoff_hash: null }, [rec()])).toBeNull();
    expect(latestReturnInfo({ state: "MANAGER_APPROVED_FINAL", revision: 2, estimator_signoff_hash: "h" }, [rec()])).toBeNull();
    expect(latestReturnInfo(rep, [])).toBeNull();
  });
  it("a record for another revision (a return whose transition then failed) is ignored", () => {
    expect(latestReturnInfo(rep, [rec({ revision: 3 })])).toBeNull();
    expect(latestReturnInfo({ ...rep, revision: 3 }, [rec({ revision: 3, reason: "later" }), rec({ revision: 2 })])?.reason).toBe("later");
  });
  it("the LATEST applicable candidate wins", () => {
    expect(latestReturnInfo(rep, [rec({ reason: "old", revision: null, at: "2026-11-03T07:00:00.000Z" }), rec({ reason: "new" })])?.reason).toBe("new");
    expect(latestReturnInfo(rep, [rec({ reason: "new" }), rec({ reason: "old", revision: null, at: "2026-11-03T07:00:00.000Z" })])?.reason).toBe("new");
  });
  it("Manager -> Estimator: applies only in review without a sign-off, and a re-sign-off clears it", () => {
    const toEst = rec({ destination: "ESTIMATOR", byRole: "manager", byEmail: "mgr@nq", reason: "Re-check the supplier price", revision: 1 });
    expect(latestReturnInfo({ state: "ESTIMATOR_REVIEW", revision: 1, estimator_signoff_hash: null }, [toEst])).toMatchObject({ destination: "ESTIMATOR", byRole: "manager", reason: "Re-check the supplier price" });
    expect(latestReturnInfo({ state: "ESTIMATOR_REVIEW", revision: 1, estimator_signoff_hash: "h" }, [toEst])).toBeNull();
    expect(latestReturnInfo(rep, [toEst])).toBeNull(); // not a Rep message
  });
  it("amount change (S1b audit row): previous -> new total, destination Rep, neutral reason, effective user over the demo owner", () => {
    const c = candidateFromActivity(row({ quoteId: "q", reason: "AMOUNT_CHANGED", previousCents: 1_000_000, newCents: 1_150_000, confirmationCleared: true, signoffCleared: true, returnedToRep: true, effectiveUser: "est@nq" }, "2026-11-03T09:00:00.000Z", CONFIRMATION_WITHDRAWN_ACTION))!;
    expect(latestReturnInfo(rep, [c])).toEqual({ kind: "AMOUNT_CHANGED", reason: NEUTRAL_REASON.AMOUNT_CHANGED, byEmail: "est@nq", byRole: null, at: "2026-11-03T09:00:00.000Z", destination: "REP", previousCents: 1_000_000, newCents: 1_150_000, source: "AUDIT" });
  });
  it("contact change (S1b audit row) falls back to the actor email; a no-op withdrawal row is not a candidate", () => {
    const c = candidateFromActivity(row({ quoteId: "q", reason: "CONTACT_CHANGED", confirmationCleared: true }, undefined, CONFIRMATION_WITHDRAWN_ACTION))!;
    expect(latestReturnInfo(rep, [c])).toMatchObject({ kind: "CONTACT_CHANGED", byEmail: "owner@nq", reason: NEUTRAL_REASON.CONTACT_CHANGED });
    expect(candidateFromActivity(row({ quoteId: "q", reason: "AMOUNT_CHANGED", confirmationCleared: false }, undefined, CONFIRMATION_WITHDRAWN_ACTION))).toBeNull();
  });
  it("a RETURNED approval request is the fallback for older returns; a record of the same decision hides it", () => {
    const ap = candidateFromApproval({ status: "RETURNED", decision_reason: "Gate width is wrong", decided_by_email: "est@nq", decided_at: "2026-11-03T08:00:01.000Z", return_destination: "PREPARER", stage: "ESTIMATOR" })!;
    expect(latestReturnInfo(rep, [ap])).toMatchObject({ source: "APPROVAL", destination: "REP", byRole: "estimator", reason: "Gate width is wrong" });
    expect(latestReturnInfo(rep, [ap, rec()])?.source).toBe("RECORD");
    expect(candidateFromApproval({ status: "APPROVED", decision_reason: "x", decided_by_email: "a", decided_at: "t" })).toBeNull();
    // a pre-record row returned to the ESTIMATOR cannot be tied to a sign-off, so it is never a candidate
    expect(candidateFromApproval({ status: "RETURNED", decision_reason: "x", decided_by_email: "a", decided_at: "2026-11-03T08:00:00Z", return_destination: "ESTIMATOR", stage: "MANAGER" })).toBeNull();
  });
  it("malformed or foreign rows are never candidates", () => {
    expect(candidateFromActivity(row({ kind: "RETURN", destination: "REP", reason: "  " }))).toBeNull();
    expect(candidateFromActivity(row({ kind: "NOPE", destination: "REP", reason: "x" }))).toBeNull();
    expect(candidateFromActivity({ action: "newquip.quote_created", detail: { quoteId: "q" }, created_at: "t" })).toBeNull();
    expect(candidateFromActivity({ action: RETURN_RECORD_ACTION, detail: null, created_at: "t" })).toBeNull();
  });
  it("a sign-off AFTER a return to the Estimator ends it; one before it does not", () => {
    const toEst = rec({ destination: "ESTIMATOR", byRole: "manager", revision: 1, at: "2026-11-03T08:00:00.000Z" });
    const q = { state: "ESTIMATOR_REVIEW", revision: 1, estimator_signoff_hash: null };
    expect(latestReturnInfo(q, { candidates: [toEst], signoffAts: ["2026-11-03T07:00:00.000Z"] })).not.toBeNull();
    expect(latestReturnInfo(q, { candidates: [toEst], signoffAts: ["2026-11-03T07:00:00.000Z", "2026-11-03T08:30:00.000Z"] })).toBeNull();
  });
  it("a voided record never shows", () => {
    expect(latestReturnInfo(rep, { candidates: [rec({ id: "r1" })], voidedIds: ["r1"] })).toBeNull();
    expect(latestReturnInfo(rep, { candidates: [rec({ id: "r1" })], voidedIds: ["r2"] })).not.toBeNull();
  });
  it("returnInfoForViewer: a Rep gets a neutral line for an Estimator-destination return, everything else is untouched", () => {
    const est = latestReturnInfo({ state: "ESTIMATOR_REVIEW", revision: 1, estimator_signoff_hash: null }, [rec({ destination: "ESTIMATOR", revision: 1, byRole: "manager", byEmail: "m@nq", reason: "secret supplier detail" })])!;
    expect(returnInfoForViewer(est, false)).toEqual({ kind: "RETURN", reason: "With the Estimator for review.", byEmail: null, byRole: null, at: est.at, destination: "ESTIMATOR", source: "RECORD" });
    expect(returnInfoForViewer(est, true)).toEqual(est);
    const toRep = latestReturnInfo(rep, [rec()])!;
    expect(returnInfoForViewer(toRep, false)).toEqual(toRep);
    expect(returnInfoForViewer(null, false)).toBeNull();
  });
  it("returnRoleOf: a stage role wins; otherwise Manager outranks Estimator outranks Rep", () => {
    expect(returnRoleOf(new Set(["rep", "estimator", "manager"]), "estimator")).toBe("estimator");
    expect(returnRoleOf(new Set(["rep", "estimator", "manager"]))).toBe("manager");
    expect(returnRoleOf(new Set(["rep", "estimator"]))).toBe("estimator");
    expect(returnRoleOf(new Set(["rep"]))).toBe("rep");
  });
});
