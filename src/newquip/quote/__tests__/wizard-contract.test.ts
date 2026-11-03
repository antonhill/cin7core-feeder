import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveStage1Steps, NO_CUSTOMER_FACTS, STAGE1_STEP_IDS, type Stage1CustomerFacts, type Stage1Input } from "../stage1-steps";
import { currentStepId, deriveWizard, isPermitted, resolveEntryStep, toRailSteps, type WizardInput, type WizardStepId } from "../wizard-contract";
import { nextIncompleteStepId } from "@/components/ui/step-rail-model";

// The wizard contract is pure: every role x state x step is pinned here with synthetic fixtures (no real quote, customer or amount).
const full: Stage1CustomerFacts = { loaded: true, available: true, hasSnapshot: true, hasContact: true, contactName: "Sean", contactEmail: "s@x.co" };
const okInput: Stage1Input = { customerName: "Acme", siteName: "Farm 1", penningPigSize: "SMALL", calcIssues: [], readinessReasons: [], customer: full };
const noWork = { lines: [], budgetLines: [], charges: [], blankExclusionCount: 0, blankPriceReasonCount: 0 };

type Roles = WizardInput["roles"];
const REP: Roles = { rep: true, estimator: false, manager: false };
const MEMBER: Roles = { rep: true, estimator: true, manager: false }; // the real "member" tier holds both
const ESTIMATOR: Roles = { rep: false, estimator: true, manager: false };
const MANAGER: Roles = { rep: false, estimator: false, manager: true };
const OBSERVER: Roles = { rep: false, estimator: false, manager: false }; // an Administrator with cost visibility but no quote role

function wiz(over: Partial<WizardInput> & { s1?: Partial<Stage1Input>; ready?: boolean } = {}) {
  const { s1, ready = true, ...rest } = over;
  const stage1 = deriveStage1Steps({ ...okInput, work: noWork, ...s1 });
  return deriveWizard({ state: "REP_DRAFT", revision: 1, stage1Status: "IN_PROGRESS", roles: REP, canViewCommercials: false, stage1, customer: (s1?.customer ?? full), readiness: { state: ready ? "READY" : "BLOCKED" }, totalAvailable: true, ...rest });
}
const by = (w: ReturnType<typeof wiz>, id: WizardStepId) => w.steps.find((s) => s.id === id)!;
const access = (w: ReturnType<typeof wiz>) => w.steps.map((s) => s.access);

describe("deriveWizard: the Rep on a Rep draft", () => {
  it("everything done: five steps, all editable, nothing locked, enters at the last incomplete step (Submit)", () => {
    const w = wiz();
    expect(w.steps.map((s) => s.id)).toEqual([...STAGE1_STEP_IDS]);
    expect(access(w)).toEqual(["edit", "edit", "edit", "edit", "edit"]);
    expect(w.steps.every((s) => s.owner === "Rep")).toBe(true);
    expect(w.entryStepId).toBe("submit");
    expect(w.returned).toBe(false);
    expect(w.nextOwner).toBe("Rep");
  });

  it("a fresh draft: step 1 is the entry; steps 2-5 are LOCKED (policy), each naming the Rep and the step to finish; Back to a permitted earlier step is never blocked", () => {
    const w = wiz({ s1: { customerName: "", siteName: "", penningPigSize: null, customer: { ...full, hasSnapshot: false, hasContact: false, contactName: null }, calcIssues: [{ field: "lengthM", code: "not_positive", message: "lengthM must be greater than zero." }] } });
    expect(w.entryStepId).toBe("customer");
    expect(access(w)).toEqual(["edit", "locked", "locked", "locked", "locked"]);
    expect(by(w, "site").blockedBy).toEqual(["Rep: choose the Cin7 customer in step 1 (Customer & contact) first."]);
    expect(by(w, "site").blockKind).toBe("policy");
    expect(by(w, "equipment").blockedBy[0]).toContain("step 1");
    // a locked step never makes the permitted ones unreachable
    expect(isPermitted(by(w, "customer"))).toBe(true);
    expect(currentStepId(w.steps, "equipment")).toBe("customer"); // a locked request falls back to the nearest earlier permitted step
  });

  it("each step unlocks only when ALL earlier steps are complete (2 after 1, 3 after 2, Review after 3)", () => {
    const noContact = wiz({ s1: { customer: { ...full, hasContact: false, contactName: null } } });
    expect(access(noContact)).toEqual(["edit", "locked", "locked", "locked", "locked"]);
    const noSite = wiz({ s1: { siteName: "" } });
    expect(access(noSite)).toEqual(["edit", "edit", "locked", "locked", "locked"]);
    expect(by(noSite, "equipment").blockedBy[0]).toContain("step 2 (Site & measurements)");
    expect(noSite.entryStepId).toBe("site");
    const noPig = wiz({ s1: { penningPigSize: null } });
    expect(access(noPig)).toEqual(["edit", "edit", "edit", "locked", "locked"]);
    expect(noPig.entryStepId).toBe("equipment");
    expect(by(noPig, "review").blockedBy[0]).toContain("step 3 (Equipment & options)");
  });

  it("the customer details still loading or unreadable keep step 2 locked, and a read failure says to reload", () => {
    const loading = wiz({ s1: { customer: NO_CUSTOMER_FACTS } });
    expect(by(loading, "site").access).toBe("locked");
    const failed = wiz({ s1: { customer: { ...NO_CUSTOMER_FACTS, loaded: true, loadError: true } } });
    expect(by(failed, "site").blockedBy[0]).toContain("could not be read; reload the page");
  });

  it("Submit has REAL (server) gates: no snapshot / no contact / not READY / no total lock it, with reasons naming the role; policy locks come first", () => {
    const blocked = wiz({ ready: false, s1: { work: { ...noWork, budgetLines: [{ label: "Cup drinker", status: "unmapped", reason: "r" }, { label: "Door", status: "supplier_quote_required", reason: "r" }] } } });
    const submit = by(blocked, "submit");
    expect(submit.access).toBe("locked");
    expect(submit.blockKind).toBe("server");
    expect(submit.blockedBy).toEqual(["Estimator: product choice needed: Cup drinker (+1 more). The quotation can be submitted once the Estimator has done this."]);
    expect(by(blocked, "review").access).toBe("edit"); // the Rep can still review and see who owes what
    expect(blocked.entryStepId).toBe("review"); // everything the Rep can act on is complete; the last step they can open
    const noTotal = wiz({ totalAvailable: false });
    expect(by(noTotal, "submit").blockedBy).toEqual(["The quotation total is not available yet."]);
    const notReadyNoOwner = wiz({ ready: false });
    expect(by(notReadyNoOwner, "submit").blockedBy[0]).toContain("must be complete");
  });

  it("Estimator-owned open work does NOT block the Rep's own steps and is carried as a note on Review", () => {
    const w = wiz({ ready: false, s1: { work: { ...noWork, budgetLines: [{ label: "Cup drinker", status: "unmapped", reason: "r" }] } } });
    expect(["customer", "site", "equipment", "review"].map((id) => by(w, id as WizardStepId).status)).toEqual(["complete", "complete", "complete", "complete"]);
    expect(by(w, "review").note).toBe("1 item waiting on the Estimator");
  });

  it("Rep-owned work (a missing quantity) keeps Equipment open and Review incomplete, and the entry step is Equipment", () => {
    const w = wiz({ ready: false, s1: { work: { ...noWork, budgetLines: [{ label: "Feeder", status: "no_quantity", reason: "r" }] } } });
    expect(by(w, "equipment").status).toBe("attention");
    expect(by(w, "review").status).toBe("incomplete");
    expect(w.entryStepId).toBe("equipment");
    expect(by(w, "review").access).toBe("locked");
  });
});

describe("deriveWizard: returned, submitted, and the other roles", () => {
  it("a RETURNED quotation (REP_DRAFT, revision > 1) sets the flag and opens at the first incomplete step, not at step 1", () => {
    const w = wiz({ revision: 2, stage1Status: "RETURNED", s1: { siteName: "" } });
    expect(w.returned).toBe(true);
    expect(w.entryStepId).toBe("site");
    const complete = wiz({ revision: 3, stage1Status: "RETURNED" });
    expect(complete.entryStepId).toBe("submit");
    expect(by(complete, "submit").note).toBe("Returned: reconfirm the amount with the customer");
  });

  it("after submission (Estimator review) every step is READ-ONLY for the Rep, nothing is locked, the Rep step reads complete and the Estimator is next", () => {
    const w = wiz({ state: "ESTIMATOR_REVIEW", stage1Status: "COMPLETE", roles: MEMBER });
    expect(access(w)).toEqual(["readonly", "readonly", "readonly", "readonly", "readonly"]);
    expect(w.submitted).toBe(true);
    expect(w.nextOwner).toBe("Estimator");
    expect(by(w, "submit").status).toBe("complete");
    expect(by(w, "submit").note).toBe("Rep preparation complete - next: Estimator");
    expect(w.entryStepId).toBe("submit");
    const done = wiz({ state: "MANAGER_APPROVED_FINAL", stage1Status: "COMPLETE", roles: MEMBER });
    expect(access(done)).toEqual(["readonly", "readonly", "readonly", "readonly", "readonly"]);
    expect(done.nextOwner).toBe("Manager");
  });

  it("an Estimator on a Rep draft, a Manager, and an Administrator observer inspect read-only: never edit, never locked, entry = the summary", () => {
    for (const roles of [ESTIMATOR, MANAGER, OBSERVER]) {
      const w = wiz({ roles, canViewCommercials: roles !== ESTIMATOR || true, s1: { siteName: "" } }); // even with incomplete data nothing is locked for a reader
      expect(access(w), JSON.stringify(roles)).toEqual(["readonly", "readonly", "readonly", "readonly", "readonly"]);
      expect(w.entryStepId).toBe("review");
      expect(w.steps.every(isPermitted)).toBe(true);
    }
  });

  it("every role x state: edit access exists ONLY for a Rep on a Rep draft; locks exist ONLY alongside edit access", () => {
    const states = ["REP_DRAFT", "ESTIMATOR_REVIEW", "MANAGER_APPROVED_FINAL"] as const;
    for (const roles of [REP, MEMBER, ESTIMATOR, MANAGER, OBSERVER]) for (const state of states) for (const ready of [true, false]) {
      const w = wiz({ roles, state, ready, stage1Status: state === "REP_DRAFT" ? "IN_PROGRESS" : "COMPLETE", s1: { siteName: ready ? "Farm" : "" } });
      const canEdit = state === "REP_DRAFT" && roles.rep;
      for (const s of w.steps) {
        const label = `${JSON.stringify(roles)} ${state} ${s.id}`;
        if (!canEdit) expect(s.access, label).toBe("readonly");
        else expect(["edit", "locked"], label).toContain(s.access);
        expect(s.blockedBy.length > 0, label).toBe(s.access === "locked");
        expect(s.owner, label).toBe("Rep");
        expect(w.steps.some(isPermitted), label).toBe(true); // never a deadlock: at least one step can always be opened
        expect(isPermitted(w.steps.find((x) => x.id === w.entryStepId)!), label).toBe(true); // the entry step is always permitted
      }
    }
  });

  it("no deadlock: whatever is incomplete, the entry step is the first incomplete step the viewer can act on", () => {
    for (const missing of ["customer", "site", "pig", "none"] as const) {
      const w = wiz({ s1: { customer: missing === "customer" ? { ...full, hasContact: false, contactName: null } : full, siteName: missing === "site" ? "" : "Farm", penningPigSize: missing === "pig" ? null : "SMALL" } });
      const firstOpen = w.steps.find((s) => s.access === "edit" && s.status !== "complete")!;
      expect(w.entryStepId).toBe(firstOpen.id);
    }
  });
});

describe("entry resolution helpers", () => {
  it("an explicit request wins ONLY if permitted; a locked or unknown request is replaced by the entry step", () => {
    const w = wiz({ s1: { siteName: "" } });
    expect(resolveEntryStep(w, "customer")).toBe("customer"); // permitted earlier step wins over the entry
    expect(resolveEntryStep(w, "site")).toBe("site");
    expect(resolveEntryStep(w, "equipment")).toBe("site"); // locked -> the entry
    expect(resolveEntryStep(w, null)).toBe("site");
  });
  it("toRailSteps carries locked + blockedBy to the shared rail; nextIncompleteStepId never offers a locked step", () => {
    const w = wiz({ s1: { siteName: "" } });
    const rail = toRailSteps(w.steps);
    expect(rail.find((s) => s.id === "equipment")).toMatchObject({ locked: true, blockedBy: expect.any(Array) });
    expect(rail.find((s) => s.id === "customer")?.locked).toBeUndefined();
    expect(nextIncompleteStepId(rail, "customer")).toBe("site");
    expect(nextIncompleteStepId(rail, "site")).toBeNull(); // the later steps are locked: nothing else to offer
  });
});

describe("the contract imports no server action, store or React", () => {
  it("static check", () => {
    const src = readFileSync(`${__dirname}/../wizard-contract.ts`, "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/**") && !l.trim().startsWith("*")).join("\n");
    const imports = [...src.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["./stages", "./stage1-steps", "@/components/ui/step-rail-model"].sort());
    expect(src).not.toMatch(/from "react"|actions|quote-store|supabase|"use client"|"use server"/);
  });
});
