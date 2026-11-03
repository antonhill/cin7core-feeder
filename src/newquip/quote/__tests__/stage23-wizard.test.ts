import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nextIncompleteStepId } from "@/components/ui/step-rail-model";
import { currentStepId, isPermitted, resolveEntryStep, toRailSteps } from "../wizard-contract";
import {
  deriveFinalReviewChecklist, deriveStage2Wizard, deriveStage3Wizard, estimatorItemText, estimatorWork, finalReviewBlockText, NOT_SUBMITTED_REASON, STAGE2_WIZARD_IDS,
  type Stage2WizardId, type Stage2WizardInput, type Stage3WizardInput,
} from "../stage23-wizard";

// The Stage 2 / Stage 3 wizard derivations are pure: every role x state is pinned here with synthetic fixtures (no real quote, customer or amount).
type Roles = Stage2WizardInput["roles"];
const REP: Roles = { rep: true, estimator: false, manager: false };
const MEMBER: Roles = { rep: true, estimator: true, manager: false }; // the real "member" tier holds both
const ESTIMATOR: Roles = { rep: false, estimator: true, manager: false };
const MANAGER: Roles = { rep: false, estimator: false, manager: true };
const OBSERVER: Roles = { rep: false, estimator: false, manager: false }; // an Administrator: cost visible, no quote role (no implicit role)
const costReview = { status: "review" as const, note: "Cin7 cost capture is checked in the Cost panel" };

function s2(over: Partial<Stage2WizardInput> = {}) {
  return deriveStage2Wizard({
    state: "ESTIMATOR_REVIEW", revision: 1, roles: ESTIMATOR, canViewCommercials: true, signoff: "none", dirty: false, calcValid: true, readiness: { state: "READY", reasons: [] },
    mappingOpen: [], repOpenCount: 0, cost: costReview, costAcknowledged: false, confirmedCents: 1000, totalCents: 1000, ...over,
  });
}
const step = (w: ReturnType<typeof s2>, id: Stage2WizardId) => w.steps.find((x) => x.id === id)!;
const access = (w: ReturnType<typeof s2>) => Object.fromEntries(w.steps.map((x) => [x.id, x.access]));

describe("deriveStage2Wizard: shape and ownership", () => {
  it("four steps in order, all owned by the Estimator, each with the shared step shape", () => {
    const w = s2();
    expect(w.steps.map((x) => x.id)).toEqual([...STAGE2_WIZARD_IDS]);
    expect(w.steps.every((x) => x.owner === "Estimator")).toBe(true);
    for (const x of w.steps) expect(Object.keys(x)).toEqual(expect.arrayContaining(["id", "label", "owner", "status", "access", "blockedBy"]));
    expect(w.steps.map((x) => x.label)).toEqual(["Product lines & mapping review", "Costs, margins & pricing exceptions", "Final review", "Sign-off or return"]);
  });
});

describe("deriveStage2Wizard: role x state matrix (access)", () => {
  it("Estimator, quotation with the Estimator: every step is theirs to edit; nothing is locked", () => {
    expect(access(s2())).toEqual({ mapping: "edit", costs: "edit", final: "edit", signoff: "edit" });
  });
  it("member (Rep + Estimator) is an editor too", () => expect(access(s2({ roles: MEMBER }))).toEqual({ mapping: "edit", costs: "edit", final: "edit", signoff: "edit" }));

  it("Estimator on a REP DRAFT: only the mapping step is theirs; 2-4 are LOCKED by the real state gate with the reason that the Rep has not submitted", () => {
    const w = s2({ state: "REP_DRAFT", mappingOpen: ["Choose the product for Feeder"], repOpenCount: 0 });
    expect(access(w)).toEqual({ mapping: "edit", costs: "locked", final: "locked", signoff: "locked" });
    for (const id of ["costs", "final", "signoff"] as const) {
      expect(step(w, id).blockedBy).toEqual([NOT_SUBMITTED_REASON]);
      expect(step(w, id).blockKind).toBe("server");
      expect(isPermitted(step(w, id))).toBe(false);
    }
    expect(NOT_SUBMITTED_REASON).toContain("The Rep has not submitted yet");
    expect(w.entryStepId).toBe("mapping");
    expect(w.statusLine).toBe("The Rep is waiting on your mapping.");
    expect(w.nextOwner).toBe("Estimator");
  });

  it("Estimator on a Rep draft with nothing to map: still locked beyond step 1; the next owner is the Rep", () => {
    const w = s2({ state: "REP_DRAFT" });
    expect(access(w).signoff).toBe("locked");
    expect(w.nextOwner).toBe("Rep");
    expect(w.statusLine).toBe("The Rep has not submitted yet. Next responsible role: Rep.");
  });

  it("a Rep draft where the Rep ALSO has open work: the Rep is the next owner, not the Estimator", () => {
    const w = s2({ state: "REP_DRAFT", mappingOpen: ["Choose the product for Feeder"], repOpenCount: 2 });
    expect(w.nextOwner).toBe("Rep");
  });

  it("Rep only: every step is read-only (nothing locked, nothing editable); not submitted -> 'Complete the Stage 1 submission'; submitted -> next owner Estimator", () => {
    const draftW = s2({ state: "REP_DRAFT", roles: REP, canViewCommercials: false });
    expect(access(draftW)).toEqual({ mapping: "readonly", costs: "hidden", final: "hidden", signoff: "readonly" });
    expect(draftW.statusLine).toBe("Complete the Stage 1 submission. Next responsible role: Rep.");
    expect(draftW.nextOwner).toBe("Rep");
    const sub = s2({ roles: REP, canViewCommercials: false });
    expect(access(sub)).toEqual({ mapping: "readonly", costs: "hidden", final: "hidden", signoff: "readonly" });
    expect(sub.statusLine).toBe("Submitted by the Rep. Next responsible role: Estimator.");
    expect(sub.nextOwner).toBe("Estimator");
    expect(sub.steps.some((x) => x.access === "edit")).toBe(false);
  });

  it("Manager and observer: read-only inspection of every step they can see; the cost steps are present for cost viewers; they hold no implicit role", () => {
    for (const roles of [MANAGER, OBSERVER]) {
      const w = s2({ roles });
      expect(access(w)).toEqual({ mapping: "readonly", costs: "readonly", final: "readonly", signoff: "readonly" });
      expect(w.steps.some((x) => x.access === "edit" || x.access === "locked")).toBe(false);
      expect(w.statusLine).toBe("Submitted by the Rep. Next responsible role: Estimator.");
    }
    // Even on a Rep draft they inspect (nothing to unlock for a non-editor)
    expect(access(s2({ roles: MANAGER, state: "REP_DRAFT" })).signoff).toBe("readonly");
  });

  it("no cost visibility: the cost steps are HIDDEN (absent from the rail), whatever the role, and nothing about cost is derived", () => {
    for (const roles of [REP, ESTIMATOR, MEMBER, MANAGER]) {
      const w = s2({ roles, canViewCommercials: false, cost: null });
      expect(step(w, "costs").access).toBe("hidden"); expect(step(w, "final").access).toBe("hidden");
      expect(toRailSteps(w.steps).map((x) => x.id)).toEqual(["mapping", "signoff"]);
    }
  });

  it("approved (final): everything is read-only and complete for everyone; nothing is next", () => {
    for (const roles of [REP, ESTIMATOR, MANAGER, OBSERVER]) {
      const w = s2({ state: "MANAGER_APPROVED_FINAL", roles, signoff: "current", canViewCommercials: roles !== REP });
      expect(w.steps.filter((x) => x.access !== "hidden").every((x) => x.access === "readonly" && x.status === "complete")).toBe(true);
      expect(w.nextOwner).toBeNull();
    }
  });
});

describe("deriveStage2Wizard: statuses come from data", () => {
  it("mapping: open Estimator items need attention for an editor (incomplete for a reader) and the note names the first and the count", () => {
    const open = ["Choose the product for Feeder", "2 manual prices need a reason"];
    expect(step(s2({ mappingOpen: open }), "mapping").status).toBe("attention");
    expect(step(s2({ mappingOpen: open }), "mapping").note).toBe("Choose the product for Feeder (+1 more)");
    expect(step(s2({ mappingOpen: open, roles: REP, canViewCommercials: false }), "mapping").status).toBe("incomplete");
    expect(step(s2(), "mapping").status).toBe("complete");
    expect(step(s2({ calcValid: false }), "mapping").status).toBe("incomplete");
  });

  it("final review: not complete until marked; marked = counted 'Reviewed' (never a check); an unsaved edit un-marks it (the acknowledgement does not survive dirty)", () => {
    expect(step(s2(), "final").status).toBe("incomplete");
    const marked = step(s2({ costAcknowledged: true }), "final");
    expect(marked).toMatchObject({ status: "review", counted: true, statusLabel: "Reviewed" });
    const dirty = step(s2({ costAcknowledged: true, dirty: true }), "final");
    expect(dirty.counted).toBeUndefined(); expect(dirty.statusLabel).toBeUndefined(); expect(dirty.status).not.toBe("review");
  });

  it("final review needs attention for the editor while something is outstanding (not READY, open mapping, differing confirmed amount)", () => {
    expect(step(s2({ readiness: { state: "BLOCKED", reasons: ["x"] } }), "final").status).toBe("attention");
    expect(step(s2({ mappingOpen: ["Choose the product for Feeder"] }), "final").status).toBe("attention");
    expect(step(s2({ confirmedCents: 5 }), "final").status).toBe("attention");
    expect(step(s2({ confirmedCents: 5, roles: MANAGER }), "final").status).toBe("incomplete"); // a reader is never told 'needs attention'
  });

  it("sign-off: none -> awaiting (READY), BLOCKED -> attention, stale -> attention, current -> complete, current + unsaved edits -> attention", () => {
    expect(step(s2(), "signoff")).toMatchObject({ status: "incomplete", note: "Awaiting your review" });
    expect(step(s2({ roles: MANAGER }), "signoff").note).toBe("Awaiting Estimator review");
    expect(step(s2({ readiness: { state: "BLOCKED", reasons: [] } }), "signoff").status).toBe("attention");
    expect(step(s2({ signoff: "stale" }), "signoff")).toMatchObject({ status: "attention", note: "The sign-off no longer matches the quotation" });
    expect(step(s2({ signoff: "current" }), "signoff").status).toBe("complete");
    expect(step(s2({ signoff: "current", dirty: true }), "signoff")).toMatchObject({ status: "attention", note: "Unsaved edits: saving makes the sign-off stale" });
  });

  it("costs: the data-derived costing status passes through; a current sign-off completes it; no costing -> unavailable", () => {
    expect(step(s2({ cost: { status: "attention", note: "1 cost override is incomplete" } }), "costs")).toMatchObject({ status: "attention", note: "1 cost override is incomplete" });
    expect(step(s2({ signoff: "current" }), "costs").status).toBe("complete");
    expect(step(s2({ cost: null, canViewCommercials: false }), "costs").status).toBe("unavailable");
  });
});

describe("deriveStage2Wizard: the entry step", () => {
  it("first incomplete step the viewer may act on: mapping when it has blockers, else costs; with a current sign-off the sign-off step", () => {
    expect(s2({ mappingOpen: ["x"] }).entryStepId).toBe("mapping");
    expect(s2().entryStepId).toBe("costs");
    expect(s2({ signoff: "current" }).entryStepId).toBe("signoff");
    expect(s2({ signoff: "current", dirty: true }).entryStepId).not.toBe("signoff"); // the sign-off is not current while edits are unsaved
  });
  it("a viewer who cannot edit opens at the first step they can open", () => {
    expect(s2({ roles: REP, canViewCommercials: false }).entryStepId).toBe("mapping");
    expect(s2({ roles: MANAGER }).entryStepId).toBe("mapping");
  });
  it("resolveEntryStep: an explicit request wins only if permitted; a locked request is replaced by the entry step", () => {
    const w = s2({ state: "REP_DRAFT", mappingOpen: ["x"] });
    expect(resolveEntryStep(w, "signoff")).toBe("mapping");
    expect(resolveEntryStep(w, "mapping")).toBe("mapping");
    expect(resolveEntryStep(s2(), "final")).toBe("final");
    expect(resolveEntryStep(s2({ roles: REP, canViewCommercials: false }), "costs")).toBe("mapping"); // hidden is not permitted
  });
  it("currentStepId: a step that became locked never strands the viewer (nearest earlier permitted step)", () => {
    const w = s2({ state: "REP_DRAFT", mappingOpen: ["x"] });
    expect(currentStepId(w.steps, "signoff")).toBe("mapping");
    expect(currentStepId(w.steps, "final")).toBe("mapping");
    expect(currentStepId(s2().steps, "signoff")).toBe("signoff");
  });
});

describe("Stage 2 with the shared rail helpers", () => {
  it("toRailSteps carries locked / blockedBy, counted and statusLabel, and drops hidden steps; a locked step is skipped by 'next incomplete'", () => {
    const w = s2({ state: "REP_DRAFT", mappingOpen: ["x"] });
    const rail = toRailSteps(w.steps);
    expect(rail.map((r) => r.id)).toEqual(["mapping", "costs", "final", "signoff"]);
    expect(rail.find((r) => r.id === "signoff")).toMatchObject({ locked: true, blockedBy: [NOT_SUBMITTED_REASON] });
    expect(nextIncompleteStepId(rail, "mapping")).toBeNull();
    const marked = toRailSteps(s2({ costAcknowledged: true }).steps);
    expect(marked.find((r) => r.id === "final")).toMatchObject({ counted: true, statusLabel: "Reviewed" });
  });
});

describe("deriveFinalReviewChecklist and finalReviewBlockText", () => {
  const base = { mappingOpen: [] as string[], readiness: { state: "READY" as const, reasons: [] as string[] }, cost: costReview, confirmedCents: 5, totalCents: 5, dirty: false, calcValid: true };
  it("rows are met from facts: mapping, READY, costing, amount; 'No unsaved edits' appears only when dirty; no costing row without cost visibility", () => {
    expect(deriveFinalReviewChecklist(base).map((x) => [x.id, x.met])).toEqual([["mapping", true], ["ready", true], ["costing", true], ["amount", true]]);
    expect(deriveFinalReviewChecklist({ ...base, cost: null }).some((x) => x.id === "costing")).toBe(false);
    const bad = deriveFinalReviewChecklist({ ...base, mappingOpen: ["Choose the product for Feeder", "b"], readiness: { state: "BLOCKED", reasons: ["Feeder is not priced"] }, confirmedCents: 4, dirty: true });
    expect(bad.filter((x) => !x.met).map((x) => x.id)).toEqual(["mapping", "ready", "amount", "saved"]);
    expect(bad.find((x) => x.id === "mapping")!.detail).toBe("Choose the product for Feeder (+1 more). Step 1.");
    expect(bad.find((x) => x.id === "ready")!.detail).toBe("Feeder is not priced");
    expect(bad.find((x) => x.id === "amount")!.detail).toMatch(/Return it to the Rep to reconfirm/);
    expect(deriveFinalReviewChecklist({ ...base, confirmedCents: null }).find((x) => x.id === "amount")!.detail).toBe("No customer price confirmation is recorded.");
  });
  it("block text: null when it can be marked or there is no costing; states the reason otherwise, in the existing words", () => {
    const ok = { state: "ESTIMATOR_REVIEW" as const, isEstimator: true, canViewCommercials: true, costStatus: "review" as const, dirty: false };
    expect(finalReviewBlockText(ok)).toBeNull();
    expect(finalReviewBlockText({ ...ok, canViewCommercials: false, costStatus: null })).toBeNull();
    expect(finalReviewBlockText({ ...ok, isEstimator: false })).toBe("You can view the costing and margin, but only the Estimator can mark it reviewed.");
    expect(finalReviewBlockText({ ...ok, state: "REP_DRAFT" })).toBe("Marking the costing reviewed is available once the quote is in Estimator review.");
    expect(finalReviewBlockText({ ...ok, costStatus: "attention", costNote: "1 cost override is incomplete" })).toBe("Resolve the costing items before marking reviewed. 1 cost override is incomplete");
    expect(finalReviewBlockText({ ...ok, dirty: true })).toBe("Save or discard your unsaved edits before marking the costing reviewed.");
    expect(finalReviewBlockText({ ...ok, costStatus: "incomplete", costNote: "Cost figures are not available yet" })).toBe("The costing cannot be marked reviewed yet. Cost figures are not available yet");
  });
  it("estimatorItemText phrases Stage 1's Estimator-owned items as instructions", () => {
    expect(estimatorItemText("Estimator mapping needed: CCM feeder")).toBe("Choose the product for CCM feeder");
    expect(estimatorItemText("Estimator: 2 manual prices need a reason")).toBe("2 manual prices need a reason");
  });
});

// ── Stage 3 ──
function s3(over: Partial<Stage3WizardInput> = {}) {
  return deriveStage3Wizard({ state: "ESTIMATOR_REVIEW", revision: 1, roles: MANAGER, signoff: "current", dirty: false, ...over });
}
describe("deriveStage3Wizard: role x state matrix", () => {
  it("two read-only/decision steps, in the shared shape; the summary is never editable", () => {
    const w = s3();
    expect(w.steps.map((x) => x.id)).toEqual(["summary", "decision"]);
    expect(w.steps.map((x) => x.owner)).toEqual(["Estimator", "Manager"]);
    expect(step3(w, "summary").access).toBe("readonly");
  });
  const step3 = (w: ReturnType<typeof s3>, id: "summary" | "decision") => w.steps.find((x) => x.id === id)!;

  it("Manager, signed off: the decision is theirs (edit), they enter there, the next owner is the Manager", () => {
    const w = s3();
    expect(step3(w, "decision").access).toBe("edit"); expect(w.entryStepId).toBe("decision"); expect(w.nextOwner).toBe("Manager");
    expect(w.statusLine).toMatch(/Your decision: approve, or return it\. Next responsible role: Manager\./);
    expect(step3(w, "summary").status).toBe("complete");
  });
  it("Manager, not signed off / stale: the decision stays open (Return is valid) but the next owner is the Estimator", () => {
    for (const signoff of ["none", "stale"] as const) {
      const w = s3({ signoff });
      expect(step3(w, "decision").access).toBe("edit"); expect(w.nextOwner).toBe("Estimator");
      expect(step3(w, "summary").status).toBe("incomplete");
    }
    expect(step3(s3({ signoff: "none" }), "decision").note).toBe("Waiting for the Estimator's sign-off");
    expect(step3(s3({ signoff: "stale" }), "decision").note).toBe("The Estimator's sign-off is out of date");
    expect(step3(s3({ dirty: true }), "decision").note).toBe("Unsaved edits: save or discard first");
  });
  it("Rep, Estimator, member and observer: read-only (no implicit Manager role); they read who decides", () => {
    for (const roles of [REP, ESTIMATOR, MEMBER, OBSERVER]) {
      const w = s3({ roles });
      expect(step3(w, "decision").access).toBe("readonly"); expect(w.entryStepId).toBe("summary");
      expect(w.steps.some((x) => x.access === "edit")).toBe(false);
      expect(w.statusLine).toBe("Signed off by the Estimator. Next responsible role: Manager.");
    }
  });
  it("a Rep draft: the decision is LOCKED by the real state gate for every role; the next owner is the Rep (returned revisions say so)", () => {
    for (const roles of [MANAGER, REP, OBSERVER]) {
      const w = s3({ roles, state: "REP_DRAFT", signoff: "none" });
      expect(step3(w, "decision")).toMatchObject({ access: "locked", blockKind: "server", blockedBy: [NOT_SUBMITTED_REASON] });
      expect(w.nextOwner).toBe("Rep");
    }
    expect(s3({ state: "REP_DRAFT", revision: 2, signoff: "none" }).statusLine).toBe("Returned to the Rep (revision 2). Next responsible role: Rep.");
    expect(s3({ state: "REP_DRAFT", revision: 2, signoff: "none" }).returned).toBe(true);
  });
  it("approved: read-only and complete; nothing is next", () => {
    const w = s3({ state: "MANAGER_APPROVED_FINAL" });
    expect(w.steps.every((x) => x.access === "readonly" && x.status === "complete")).toBe(true);
    expect(w.nextOwner).toBe("Rep");
    expect(w.statusLine).toBe("Approved. Next: Rep issues and sends the customer quotation (Stage 4).");
  });
});

describe("UX-006i2 static: the new derivation and presentation import no server action or store", () => {
  const roots = [join(__dirname, ".."), join(__dirname, "../../../app/newquip-grower/[id]")];
  for (const [f, r] of [["stage23-wizard.ts", 0], ["wizard-contract.ts", 0], ["Stage23Panels.tsx", 1]] as const) it(f, () => {
    expect(readdirSync(roots[r])).toContain(f);
    const src = readFileSync(join(roots[r], f), "utf8");
    expect(src).not.toMatch(/from "[^"]*(actions|-store|supabase|server-only)[^"]*"/);
    if (f.endsWith(".ts")) expect(src).not.toMatch(/from "react"|"use client"|"use server"/);
  });
});

describe("UX-006i2 review fixes (pure)", () => {
  it("estimatorWork derives the CURRENT open items by KIND and lists each line once: confirmed mappings leave only the manual prices; a blank-reason count is its own item", () => {
    const before = estimatorWork([{ label: "Feeder", status: "unmapped" }, { label: "Feeder", status: "unmapped" }, { label: "Slats", status: "package_unconfirmed" }, { label: "Door", status: "not_in_price_source" }, { label: "Light", status: "priced" }], 0);
    expect(before.map).toEqual(["Choose or confirm the product for Feeder", "Choose or confirm the product for Slats"]);
    expect(before.price).toEqual(["Enter a manual quotation price for Door"]);
    const after = estimatorWork([{ label: "Feeder", status: "priced" }, { label: "Door", status: "supplier_quote_required" }], 2);
    expect(after.map).toEqual([]);
    expect(after.all).toEqual(["Enter a manual quotation price for Door", "2 manual prices need a reason"]);
    expect(estimatorWork(null, 1).all).toEqual(["1 manual price needs a reason"]);
    expect(estimatorWork([{ label: "M75", status: "estimator_price_required" }], 0).all).toEqual([]); // a Rep-owned input is not the Estimator's
  });
  it("the costs step reads 'To review in Final review' until marked, then a counted 'Reviewed' (session only); the checklist no longer overclaims", () => {
    expect(step(s2(), "costs").statusLabel).toBe("To review in Final review");
    expect(step(s2(), "costs").counted).toBeUndefined();
    expect(step(s2({ costAcknowledged: true }), "costs")).toMatchObject({ counted: true, statusLabel: "Reviewed" });
    expect(step(s2({ costAcknowledged: true, dirty: true }), "costs").counted).toBeUndefined();
    const item = deriveFinalReviewChecklist({ mappingOpen: [], readiness: { state: "READY", reasons: [] }, cost: costReview, confirmedCents: 1, totalCents: 1, dirty: false, calcValid: true }).find((x) => x.id === "costing")!;
    expect(item.label).toBe("Costing figures are available");
    const inc = deriveFinalReviewChecklist({ mappingOpen: [], readiness: { state: "READY", reasons: [] }, cost: costReview, confirmedCents: 1, totalCents: 1, dirty: false, calcValid: true, costMissingLines: 12 }).find((x) => x.id === "costing")!;
    expect(inc).toMatchObject({ label: "Costing figures: incomplete (12 lines have no cost)", met: false });
    expect(inc.detail).toMatch(/indicative \(price-list basis\).*You may still sign off/);
    expect(step(s2({ costMissingLines: 12 }), "final").status).toBe("attention"); // never "Met" / quietly fine
    expect(item.detail).toMatch(/Cin7 cost capture.*may still show incomplete/);
  });
});

import { stageLabelOf, QUOTE_STATE_LABEL, waitingOn } from "../workflow";
describe("UX-006i2 round 2: the quote list's Stage column agrees with 'Waiting on'", () => {
  it("signed off -> 'Manager approval' (with waitingOn 'Manager: approval'); unsigned review keeps the state label", () => {
    expect(stageLabelOf({ state: "ESTIMATOR_REVIEW", signed_off: true })).toBe("Manager approval");
    expect(waitingOn({ state: "ESTIMATOR_REVIEW", revision: 1, signed_off: true })).toBe("Manager: approval");
    expect(stageLabelOf({ state: "ESTIMATOR_REVIEW", signed_off: false })).toBe(QUOTE_STATE_LABEL.ESTIMATOR_REVIEW);
    expect(stageLabelOf({ state: "REP_DRAFT", signed_off: true })).toBe(QUOTE_STATE_LABEL.REP_DRAFT);
  });
});

import { commercialReadiness, confirmedAmountChange } from "../stage23-wizard";
describe("UX-006 corrections: commercial readiness and the confirmed-amount change (pure)", () => {
  const lines = [{ label: "Feeder", status: "unmapped" }, { label: "Slats", status: "package_unconfirmed" }, { label: "Door", status: "supplier_quote_required" }, { label: "Light", status: "not_in_price_source" }, { label: "Tank", status: "priced" }];
  it("counts what is unresolved by kind, names the owner of each item, and says the amounts are indicative", () => {
    const c = commercialReadiness({ lines, blankPriceReasonCount: 1, costMissingLines: 7 });
    expect(c).toMatchObject({ complete: false, unmapped: 2, quotesRequired: 2, noCost: 7, reasonsOpen: 1 });
    expect(c.headline).toBe("Not commercially ready: 2 lines unmapped · 2 supplier quotes required · 7 lines have no cost · 1 manual price needs a reason (amounts are indicative)");
    expect(c.items.every((x) => x.owner === "Estimator")).toBe(true);
    expect(c.items.map((x) => x.text)).toContain("7 lines have no cost: capture it from Cin7 or enter a manual estimate (step 2)");
    expect(c.items.some((x) => x.text === "Enter a manual quotation price for Door")).toBe(true);
  });
  it("is complete only when nothing is open, with no headline", () => {
    expect(commercialReadiness({ lines: [{ label: "Tank", status: "priced" }], blankPriceReasonCount: 0, costMissingLines: 0 })).toMatchObject({ complete: true, headline: null, items: [] });
    expect(commercialReadiness({ lines: null, blankPriceReasonCount: 0, costMissingLines: 1 }).complete).toBe(false);
    expect(commercialReadiness({ lines: [{ label: "Feeder", status: "unmapped" }], blankPriceReasonCount: 0, costMissingLines: 0 }).headline).toMatch(/1 line unmapped/);
  });
  it("confirmedAmountChange: silent when equal or nothing was confirmed; otherwise says from what to what and that the Rep reconfirms", () => {
    expect(confirmedAmountChange(1000, 1000)).toEqual({ changed: false, text: null });
    expect(confirmedAmountChange(null, 1000).changed).toBe(false);
    expect(confirmedAmountChange(1000, null).changed).toBe(false);
    const c = confirmedAmountChange(100000, 125050);
    expect(c.changed).toBe(true);
    expect(c.text).toMatch(/^The total changed from what the customer confirmed \(R.*1.*000,00 -> R.*1.*250,50\)\. Return to the Rep to reconfirm\.$/);
  });
  it("Costs needs attention with the number of lines with no cost, and Mapping uses the by-kind summary as its note", () => {
    const w = s2({ costMissingLines: 7, mappingOpen: ["x"], mappingSummary: "2 lines unmapped · 1 supplier quote required" });
    expect(step(w, "costs")).toMatchObject({ status: "attention", note: "7 lines have no cost" });
    expect(step(w, "mapping").note).toBe("2 lines unmapped · 1 supplier quote required");
    expect(step(s2({ costMissingLines: 7, roles: MANAGER }), "costs").status).toBe("incomplete");
    expect(step(s2({ costMissingLines: 7, costAcknowledged: true }), "costs")).toMatchObject({ counted: true });
    expect(step(s2({ costMissingLines: 7, costAcknowledged: true }), "costs").note).toMatch(/7 lines still have no cost/);
  });
});
