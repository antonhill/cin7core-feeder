import { describe, expect, it } from "vitest";
import { nextIncompleteStepId } from "@/components/ui/step-rail-model";
import { costAckKey, deriveStage2Steps, nextCandidates, stage2StepIds, type Stage2Input } from "../stage2-steps";

const line = (over: Record<string, unknown> = {}) => ({ basis: "system_calculated", exclusionReason: null, inputRequired: null, overrideState: "none", overrideReason: null, ...over });
const REP = { rep: true, estimator: false, manager: false };
const EST = { rep: false, estimator: true, manager: false };
const MGR = { rep: false, estimator: false, manager: true };
const ok: Stage2Input = {
  canViewCommercials: true, editable: true, costAcknowledged: false, roles: REP, state: "REP_DRAFT", revision: 1, calcValid: true, lines: [line(), line()],
  readiness: { state: "READY", reasons: [], missingMappings: 0 },
  budget: { incomplete: false, estimatedCost: 1000, marginPct: 25, lines: [{ status: "priced" }], charges: [{ label: "Delivery", status: "entered" }] },
  blankExclusionCount: 0, incompleteCostOverrideCount: 0, blankPriceReasonCount: 0, totalAvailable: true, confirmedRecorded: false, signoff: "none", dirty: false,
};
const d = (o: Partial<Stage2Input>) => deriveStage2Steps({ ...ok, ...o });
const by = (o: Partial<Stage2Input>) => Object.fromEntries(d(o).steps.map((s) => [s.id, s.status]));
const note = (o: Partial<Stage2Input>, id: string) => d(o).steps.find((s) => s.id === id)?.note;
const grp = (o: Partial<Stage2Input>, id: "rep" | "estimator") => d(o).groups.find((g) => g.id === id)!;
const sub = { state: "ESTIMATOR_REVIEW" as const };

describe("Stage 2 steps and groups (UX-006b)", () => {
  it("a viewer without cost visibility has FOUR steps (no Cost & margin) and nothing names cost or margin; with cost visibility there are five", () => {
    expect(stage2StepIds(false)).toEqual(["lines", "charges", "submit", "signoff"]);
    expect(stage2StepIds(true)).toEqual(["lines", "charges", "submit", "cost", "signoff"]);
    const x = d({ canViewCommercials: false });
    expect(x.steps.map((s) => s.id)).toEqual(["lines", "charges", "submit", "signoff"]);
    expect(JSON.stringify(x)).not.toMatch(/cost|margin/i);
    expect(x.groups.find((g) => g.id === "estimator")!.total).toBe(1); // only the sign-off counts for them
  });
  it("groups: Rep preparation owns lines, charges and submit; Estimator review owns cost and sign-off; each counts only its own steps", () => {
    const x = d({});
    expect(x.groups.map((g) => [g.id, g.stepIds])).toEqual([["rep", ["lines", "charges", "submit"]], ["estimator", ["cost", "signoff"]]]);
    expect(grp({}, "rep").progress).toBe("2 of 3 complete"); // submit is NOT complete until the workflow says so
    expect(grp({}, "estimator").progress).toBe("0 of 2 complete");
  });

  // ── lines / charges / cost ──
  it("lines: complete when every mapping, quantity and override reason is settled; otherwise attention with counts", () => {
    expect(by({}).lines).toBe("complete");
    expect(note({ readiness: { ...ok.readiness, missingMappings: 2 } }, "lines")).toBe("2 mappings to confirm");
    expect(note({ lines: [line({ inputRequired: "x" })] }, "lines")).toBe("1 quantity to enter");
    expect(note({ lines: [line({ overrideState: "manual_override", overrideReason: null })] }, "lines")).toBe("1 override reason missing");
    expect(by({ lines: [line({ inputRequired: "x", exclusionReason: "Customer supplies" }), line({ basis: "not_selected", inputRequired: "x" })] }).lines).toBe("complete");
  });
  it("before Stage 1 is valid there is nothing to decide", () => {
    const s = by({ calcValid: false, budget: null });
    expect([s.lines, s.charges, s.cost]).toEqual(["incomplete", "incomplete", "incomplete"]);
  });
  it("charges: blank exclusion reason, blank manual-price reason, unpriced line and unentered charge each need attention", () => {
    expect(by({}).charges).toBe("complete");
    expect(note({ blankExclusionCount: 1 }, "charges")).toBe("1 excluded item needs a reason");
    expect(note({ blankPriceReasonCount: 2 }, "charges")).toBe("2 manual prices need a reason");
    expect(note({ budget: { ...ok.budget!, lines: [{ status: "supplier_quote_required" }] } }, "charges")).toBe("1 line needs a price");
    expect(note({ budget: { ...ok.budget!, charges: [{ label: "Delivery", status: "required" }] } }, "charges")).toBe("1 charge not entered");
  });
  it("cost: a complete estimate on a draft is only Review (Cin7 cost capture is unknown here); Complete once frozen; partial, no margin or an incomplete override need attention", () => {
    expect(by({}).cost).toBe("review");
    expect(by({ state: "MANAGER_APPROVED_FINAL" }).cost).toBe("complete");
    expect(by({ roles: MGR, budget: { ...ok.budget!, incomplete: true } }).cost).toBe("attention");
    expect(by({ roles: MGR, budget: { ...ok.budget!, marginPct: null } }).cost).toBe("attention");
    expect(note({ roles: MGR, incompleteCostOverrideCount: 1 }, "cost")).toBe("1 cost override is incomplete");
    expect(note({ budget: null }, "cost")).toBe("Cost figures are not available yet");
  });

  // ── workflow: every state x role ──
  it("REP_DRAFT, preparation incomplete: Rep group 'Preparation incomplete'; Estimator group waits for the Rep; submit needs attention; sign-off is Not complete and WAITING", () => {
    const o = { roles: REP, readiness: { state: "BLOCKED" as const, reasons: ["x"], missingMappings: 1 } };
    expect(grp(o, "rep").statusLine).toBe("Preparation incomplete");
    expect(grp(o, "estimator").statusLine).toBe("Waiting for the Rep to submit");
    expect(by(o).submit).toBe("attention");
    expect(note(o, "signoff")).toBe("Waiting for the Rep to submit");
    expect(d(o).actionable.has("signoff")).toBe(false);
  });
  it("REP_DRAFT, READY and prepared: 'Ready - not yet submitted'; submit is Not complete (never complete from Rep data alone); the Estimator is NOT yet responsible", () => {
    expect(grp({}, "rep").statusLine).toBe("Ready - not yet submitted");
    expect(by({}).submit).toBe("incomplete");
    expect(note({}, "submit")).toBe("Ready for the price confirmation");
    expect(grp({}, "estimator").statusLine).toBe("Waiting for the Rep to submit");
    expect(by({}).signoff).toBe("incomplete");
  });
  it("REP_DRAFT, READY but a charge is open: still 'Preparation incomplete' (workflow never claims ready when the data says otherwise)", () => {
    expect(grp({ blankExclusionCount: 1 }, "rep").statusLine).toBe("Preparation incomplete");
  });
  it("another role's step never says 'Needs attention' to the viewer: a Rep sees the Estimator's sign-off as Not complete, an Estimator sees the Rep's steps likewise; a Manager sees both as they are", () => {
    const blocked = { ...sub, readiness: { state: "BLOCKED" as const, reasons: ["x"], missingMappings: 1 }, blankExclusionCount: 1 };
    expect(by({ ...blocked, roles: REP }).signoff).toBe("incomplete");
    expect(by({ ...blocked, roles: REP }).lines).toBe("attention"); // their own
    expect(by({ ...blocked, roles: EST }).charges).toBe("incomplete");
    expect(by({ ...blocked, roles: EST }).signoff).toBe("attention");
    expect(by({ ...blocked, roles: MGR })).toMatchObject({ charges: "attention", signoff: "attention" });
    expect(grp({ ...blocked, roles: REP }, "estimator").attention).toBe(0);
  });
  it("REP_DRAFT, no total: submit needs attention", () => { expect(by({ totalAvailable: false }).submit).toBe("attention"); });
  it("submitted (ESTIMATOR_REVIEW, unsigned): Rep group 'Submitted - awaiting the Estimator' and ALL the Rep's steps are complete; the Estimator is the next responsible role", () => {
    const o = { ...sub, roles: REP, confirmedRecorded: true };
    expect(by(o)).toMatchObject({ lines: "complete", charges: "complete", submit: "complete" });
    expect(grp(o, "rep").statusLine).toBe("Submitted - awaiting the Estimator");
    expect(grp(o, "rep").progress).toBe("3 of 3 complete");
    expect(grp(o, "estimator").statusLine).toBe("Awaiting Estimator review");
    expect(note(o, "signoff")).toBe("Awaiting Estimator review");
  });
  it("submitted, seen by the Estimator: 'Awaiting your review'; by a Manager: 'Awaiting Estimator review'", () => {
    expect(grp({ ...sub, roles: EST }, "estimator").statusLine).toBe("Awaiting your review");
    expect(grp({ ...sub, roles: MGR }, "estimator").statusLine).toBe("Awaiting Estimator review");
  });
  it("submitted, NOT READY (content changed): sign-off needs attention", () => {
    expect(by({ ...sub, roles: EST, readiness: { state: "BLOCKED", reasons: ["x"], missingMappings: 1 } }).signoff).toBe("attention");
  });
  it("returned to the Rep (REP_DRAFT, revision 2): Rep group 'Returned', Estimator group 'Returned to the Rep', sign-off waiting; submit offers the reconfirmation", () => {
    const o = { revision: 2 };
    expect(grp(o, "rep").statusLine).toBe("Returned to the Rep (revision 2)");
    expect(grp(o, "estimator").statusLine).toBe("Returned to the Rep");
    expect(note(o, "signoff")).toBe("Returned to the Rep (revision 2)");
    expect(note(o, "submit")).toBe("Returned: reconfirm the amount with the customer");
  });
  it("revision 1 in REP_DRAFT is NOT a return", () => { expect(grp({ revision: 1 }, "rep").statusLine).not.toMatch(/Returned/); });
  it("signed off (hash == draft hash): Estimator group and sign-off Complete; Rep group says 'Signed off'", () => {
    const o = { ...sub, signoff: "current" as const };
    expect(by(o).signoff).toBe("complete");
    expect(grp(o, "estimator").statusLine).toBe("Signed off");
    expect(grp(o, "rep").statusLine).toBe("Signed off");
  });
  it("signed off but the page has unsaved edits: attention (saving would make it stale)", () => {
    const o = { ...sub, roles: EST, signoff: "current" as const, dirty: true };
    expect(by(o).signoff).toBe("attention");
    expect(note(o, "signoff")).toBe("Unsaved edits: saving makes the sign-off stale");
    expect(grp(o, "estimator").tone).toBe("warning");
  });
  it("stale sign-off: Estimator group asks for another review; attention", () => {
    const o = { ...sub, roles: EST, signoff: "stale" as const };
    expect(by(o).signoff).toBe("attention");
    expect(grp(o, "estimator").statusLine).toBe("Sign-off out of date: review again");
  });
  it("approved: every step complete (cost included) and both groups say Approved", () => {
    const o = { state: "MANAGER_APPROVED_FINAL" as const };
    expect(Object.values(by(o)).every((s) => s === "complete")).toBe(true);
    expect(grp(o, "rep").statusLine).toBe("Approved"); expect(grp(o, "estimator").statusLine).toBe("Approved");
    expect(d(o).actionable.size).toBe(0);
  });

  // ── what is the viewer's to do ──
  it("Next incomplete is scoped to the viewer AND to whose turn it is: the Rep's steps only while it is a Rep draft; nothing for the Rep once submitted", () => {
    expect([...d({ roles: REP }).actionable].sort()).toEqual(["charges", "lines", "submit"]);
    expect(d({ ...sub, roles: REP }).actionable.size).toBe(0); // submitted: nothing for the Rep, even if a Rep step is not Complete
    expect(d({ ...sub, roles: REP, blankExclusionCount: 1 }).actionable.has("charges")).toBe(false);
  });
  it("the Estimator's work (cost, sign-off) is actionable only once the quote is in Estimator review; a Manager follows the same turn order with oversight", () => {
    expect([...d({ ...sub, roles: EST }).actionable].sort()).toEqual(["cost", "signoff"]);
    expect(d({ roles: EST }).actionable.size).toBe(0); // still a Rep draft: not the Estimator's turn
    expect(d({ ...sub, roles: MGR }).actionable.has("signoff")).toBe(true);
    expect(d({ roles: MGR }).actionable.has("lines")).toBe(true);
  });
  it("nextCandidates keeps the current step so the position is known, and drops other roles' steps", () => {
    const x = d({ ...sub, roles: REP });
    expect(nextCandidates(x, "signoff").map((s) => s.id)).toEqual(["signoff"]);
    expect(nextCandidates(d({ roles: REP }), "lines").map((s) => s.id)).toEqual(["lines", "charges", "submit"]);
  });
  it("every combination of cost visibility x cost state with a current sign-off: label, count and group line agree, and non-commercial viewers get no cost wording", () => {
    const signed = { ...sub, signoff: "current" as const };
    const cost = (o: Partial<Stage2Input>) => d({ ...signed, roles: EST, ...o });
    // commercial, review -> counted + 'Reviewed', 2 of 2, Signed off
    let x = cost({}); expect(x.steps.find((q) => q.id === "cost")).toMatchObject({ status: "review", counted: true, statusLabel: "Reviewed" });
    expect([x.groups[1].progress, x.groups[1].statusLine]).toEqual(["2 of 2 complete", "Signed off"]);
    // commercial, attention (partial budget) -> not counted, 1 of 2, honest line
    x = cost({ budget: { ...ok.budget!, incomplete: true } }); expect(x.steps.find((q) => q.id === "cost")).toMatchObject({ status: "attention" });
    expect(x.steps.find((q) => q.id === "cost")!.counted).toBeUndefined();
    expect([x.groups[1].progress, x.groups[1].statusLine, x.groups[1].tone]).toEqual(["1 of 2 complete", "Signed off - cost attention outstanding", "warning"]);
    x = cost({ incompleteCostOverrideCount: 1 }); expect(x.groups[1].statusLine).toBe("Signed off - cost attention outstanding");
    // commercial, final -> Complete label, no override
    x = d({ state: "MANAGER_APPROVED_FINAL", roles: EST }); expect(x.steps.find((q) => q.id === "cost")).toMatchObject({ status: "complete" });
    expect(x.steps.find((q) => q.id === "cost")!.statusLabel).toBeUndefined();
    // non-commercial: no cost step, 1 of 1, plain 'Signed off', and no cost wording anywhere even when the budget is partial
    x = cost({ canViewCommercials: false, budget: { ...ok.budget!, incomplete: true } });
    expect([x.groups[1].progress, x.groups[1].statusLine]).toEqual(["1 of 1 complete", "Signed off"]);
    expect(JSON.stringify(x)).not.toMatch(/cost|margin/i);
  });
  it("a viewer who cannot edit is not pushed to Rep work; an Estimator-only viewer sees unfinished Rep steps as 'Waiting on the Rep' (no cost wording)", () => {
    expect(d({ roles: REP, editable: false }).actionable.size).toBe(0);
    expect(d({ roles: MGR, editable: false }).actionable.has("lines")).toBe(false);
    const x = d({ roles: EST, blankExclusionCount: 1, canViewCommercials: false });
    expect(x.steps.find((q) => q.id === "charges")).toMatchObject({ status: "incomplete", note: "Waiting on the Rep" });
    expect(x.steps.find((q) => q.id === "lines")!.note).toBeUndefined(); // complete steps keep their own (empty) note
    expect(JSON.stringify(x)).not.toMatch(/cost|margin/i);
    expect(d({ roles: REP, blankExclusionCount: 1 }).steps.find((q) => q.id === "charges")!.note).toBe("1 excluded item needs a reason"); // the Rep keeps the real note
  });
  it("a client-local cost acknowledgement (Estimator/Manager, Estimator review, commercial, no unsaved edits): Reviewed + counted, count moves, the group line does NOT claim a sign-off, next-incomplete goes to sign-off", () => {
    const acked = { ...sub, roles: EST, costAcknowledged: true };
    const x = d(acked);
    expect(x.steps.find((q) => q.id === "cost")).toMatchObject({ status: "review", counted: true, statusLabel: "Reviewed", note: "You marked this reviewed - this is not a sign-off" });
    expect([x.groups[1].progress, x.groups[1].statusLine]).toEqual(["1 of 2 complete", "Awaiting your review"]);
    expect(by(acked).signoff).toBe("incomplete"); // the formal sign-off is untouched
    expect(nextIncompleteStepId(nextCandidates(x, "lines"), "lines")).toBe("signoff");
    expect(d({ ...acked, roles: MGR }).steps.find((q) => q.id === "cost")!.counted).toBe(true); // a Manager may acknowledge
    // not acknowledged: Review needed, not counted
    expect(d({ ...sub, roles: EST }).steps.find((q) => q.id === "cost")).toMatchObject({ status: "review" });
    expect(d({ ...sub, roles: EST }).steps.find((q) => q.id === "cost")!.counted).toBeUndefined();
  });
  it("with a current sign-off the formal sign-off governs: an acknowledgement does not rewrite the Cost note to 'You marked this reviewed'", () => {
    const x = d({ ...sub, roles: EST, signoff: "current", costAcknowledged: true });
    expect(x.steps.find((q) => q.id === "cost")).toMatchObject({ counted: true, statusLabel: "Reviewed", note: "Cin7 cost capture is checked in the Cost panel" });
  });
  it("an acknowledgement never applies: with unsaved edits, outside Estimator review, to a Rep, or without cost visibility", () => {
    const acked = { ...sub, roles: EST, costAcknowledged: true };
    expect(d({ ...acked, dirty: true }).steps.find((q) => q.id === "cost")!.counted).toBeUndefined();
    expect(d({ ...acked, state: "REP_DRAFT" }).steps.find((q) => q.id === "cost")!.counted).toBeUndefined();
    expect(d({ ...acked, roles: REP }).steps.find((q) => q.id === "cost")!.counted).toBeUndefined();
    expect(JSON.stringify(d({ ...acked, canViewCommercials: false }))).not.toMatch(/cost|margin|reviewed/i);
    expect(d({ ...acked, budget: { ...ok.budget!, incomplete: true } }).steps.find((q) => q.id === "cost")).toMatchObject({ status: "attention" }); // an attention state is not papered over
  });
  it("after a current sign-off the reviewed Cost step counts as done (no Complete label) so the group count and status agree; with unsaved edits it does not", () => {
    const signed = { ...sub, roles: EST, signoff: "current" as const };
    expect(grp(signed, "estimator").progress).toBe("2 of 2 complete");
    expect(grp(signed, "estimator").statusLine).toBe("Signed off");
    expect(d(signed).steps.find((x) => x.id === "cost")).toMatchObject({ status: "review", counted: true });
    expect(by(signed).cost).toBe("review"); // the label stays honest
    expect(nextIncompleteStepId(nextCandidates(d(signed), "lines"), "lines")).toBeNull(); // nothing left for the Estimator
    expect(grp({ ...signed, dirty: true }, "estimator").progress).toBe("0 of 2 complete");
    expect(d({ ...sub, roles: EST }).steps.find((x) => x.id === "cost")!.counted).toBeUndefined(); // not before sign-off
  });
});

describe("costAckKey: every component invalidates an acknowledgement on its own", () => {
  const base = { quoteId: "q1", revision: 1, draftHash: "h1", updatedAt: "2026-11-03T08:00:00Z", estimatedCost: 1000, marginPct: 25 };
  it("the same facts give the same key (stable across renders)", () => { expect(costAckKey(base)).toBe(costAckKey({ ...base })); });
  it.each([
    ["updated_at only", { updatedAt: "2026-11-03T08:00:01Z" }],
    ["draft_hash only", { draftHash: "h2" }],
    ["revision only", { revision: 2 }],
    ["estimated cost only", { estimatedCost: 1001 }],
    ["margin only", { marginPct: 24.9 }],
    ["margin becoming unknown", { marginPct: null }],
    ["a different quote", { quoteId: "q2" }],
  ])("%s changes the key", (_n, patch) => { expect(costAckKey({ ...base, ...patch })).not.toBe(costAckKey(base)); });
});
