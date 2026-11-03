import { describe, expect, it } from "vitest";
import { NO_CUSTOMER_FACTS, deriveStage1Steps, type Stage1CustomerFacts, type Stage1Input } from "../stage1-steps";

const full: Stage1CustomerFacts = { loaded: true, available: true, hasSnapshot: true, hasContact: true, contactName: "Sean" };
const ok: Stage1Input = { customerName: "Topigs", siteName: "Farm 1", penningPigSize: "SMALL", calcIssues: [], readinessReasons: [], customer: full };
const status = (i: Stage1Input) => Object.fromEntries(deriveStage1Steps(i).steps.map((s) => [s.id, s.status]));
const note = (i: Stage1Input, id: string) => deriveStage1Steps(i).steps.find((s) => s.id === id)?.note;

describe("deriveStage1Steps (UX-006a): completion comes from data only", () => {
  it("everything satisfied: five steps, all complete, no issues", () => {
    const d = deriveStage1Steps(ok);
    expect(d.steps.map((s) => s.id)).toEqual(["customer", "site", "room", "equipment", "review"]);
    expect(d.steps.every((s) => s.status === "complete")).toBe(true);
    expect(d.issues).toEqual([]);
  });
  it("a typed customer name WITHOUT a Cin7 snapshot is Needs attention, with the handoff note (never complete)", () => {
    const i = { ...ok, customer: { ...full, hasSnapshot: false, hasContact: false, contactName: null } };
    expect(status(i).customer).toBe("attention");
    expect(note(i, "customer")).toBe("Needed before sending to the Estimator");
    expect(status(i).review).toBe("incomplete"); // the review is complete only when every earlier step is
    expect(deriveStage1Steps(i).issues).toEqual([]); // ...but a missing snapshot is a handoff need, not a Stage 1 readiness reason
  });
  it("a snapshot without a chosen contact still needs attention; with the contact it is complete", () => {
    expect(status({ ...ok, customer: { ...full, hasContact: false, contactName: null } }).customer).toBe("attention");
    expect(status(ok).customer).toBe("complete");
  });
  it("no name at all is Not complete; customer details still loading is never complete", () => {
    expect(status({ ...ok, customerName: "  " }).customer).toBe("incomplete");
    expect(status({ ...ok, customer: NO_CUSTOMER_FACTS }).customer).toBe("incomplete");
  });
  it("before the customer snapshot feature exists the typed name is used (matches the Stage 2 handoff, which does not block then)", () => {
    expect(status({ ...ok, customer: { ...NO_CUSTOMER_FACTS, loaded: true, available: false } }).customer).toBe("complete");
  });
  it("site step needs a site name only", () => {
    expect(status({ ...ok, siteName: " " }).site).toBe("incomplete");
    expect(status(ok).site).toBe("complete");
  });
  it("room measurement issues put the room step in Needs attention and are listed against it; equipment issues against equipment", () => {
    const i: Stage1Input = { ...ok, calcIssues: [{ field: "lengthM", message: "lengthM must be greater than zero." }, { field: "penningRunningMetresPerRoom", message: "penningRunningMetresPerRoom can't be negative." }] };
    const d = deriveStage1Steps(i);
    expect(status(i).room).toBe("attention");
    expect(status(i).equipment).toBe("attention");
    expect(d.issues).toEqual([{ message: "lengthM must be greater than zero.", stepId: "room" }, { message: "penningRunningMetresPerRoom can't be negative.", stepId: "equipment" }]);
    expect(status(i).review).toBe("incomplete");
  });
  it("pig size not chosen leaves equipment Not complete (no calculation issue exists for it)", () => {
    expect(status({ ...ok, penningPigSize: null }).equipment).toBe("incomplete");
    expect(status({ ...ok, penningPigSize: undefined }).equipment).toBe("incomplete");
  });
  it("unsupported-selection warnings and Stage 2 quantity issues never mark a Stage 1 step", () => {
    const i: Stage1Input = { ...ok, calcIssues: [{ field: "selectedFeederType", code: "unsupported_selection", message: "x" }, { field: "quantityOverrides.led_light", message: "An override must be a number ≥ 0." }] };
    expect(status(i)).toMatchObject({ room: "complete", equipment: "complete", review: "complete" });
  });
  it("readiness reasons that Stage 1 cannot fix are reported as Stage 2 reasons, not Stage 1 issues", () => {
    const d = deriveStage1Steps({ ...ok, siteName: "", readinessReasons: ["Site / project name is required.", "Feeder: quantity required"] });
    expect(d.issues).toEqual([{ message: "Site / project name is required.", stepId: "site" }]);
    expect(d.stage2Reasons).toEqual(["Feeder: quantity required"]);
  });
  it("missing customer and site produce issues pointing at their own steps", () => {
    const d = deriveStage1Steps({ ...ok, customerName: "", siteName: "" });
    expect(d.issues.map((i) => i.stepId)).toEqual(["customer", "site"]);
  });
});
