import { describe, expect, it } from "vitest";
import { NO_CUSTOMER_FACTS, customerFactsSettled, deriveStage1Steps, ownedWork, type Stage1CustomerFacts, type Stage1Input } from "../stage1-steps";

const full: Stage1CustomerFacts = { loaded: true, available: true, hasSnapshot: true, hasContact: true, contactName: "Sean" };
const ok: Stage1Input = { customerName: "Topigs", siteName: "Farm 1", penningPigSize: "SMALL", calcIssues: [], readinessReasons: [], customer: full };
const status = (i: Stage1Input) => Object.fromEntries(deriveStage1Steps(i).steps.map((s) => [s.id, s.status]));
const note = (i: Stage1Input, id: string) => deriveStage1Steps(i).steps.find((s) => s.id === id)?.note;

describe("deriveStage1Steps (UX-006a): completion comes from data only", () => {
  it("everything satisfied: the three content steps, all complete, no issues (Review and Submit are derived by the wizard contract)", () => {
    const d = deriveStage1Steps(ok);
    expect(d.steps.map((s) => s.id)).toEqual(["customer", "site", "equipment"]);
    expect(d.steps.every((s) => s.status === "complete")).toBe(true);
    expect(d.issues).toEqual([]);
  });
  it("a typed customer name WITHOUT a Cin7 snapshot is Needs attention, with the handoff note (never complete)", () => {
    const i = { ...ok, customer: { ...full, hasSnapshot: false, hasContact: false, contactName: null } };
    expect(status(i).customer).toBe("attention");
    expect(note(i, "customer")).toBe("Select the Cin7 customer. Needed before sending to the Estimator");
    expect(deriveStage1Steps(i).issues).toEqual([]); // ...but a missing snapshot is a handoff need, not a Stage 1 readiness reason
  });
  it("a snapshot without a chosen contact still needs attention; with the contact it is complete", () => {
    expect(status({ ...ok, customer: { ...full, hasContact: false, contactName: null } }).customer).toBe("attention");
    expect(status(ok).customer).toBe("complete");
  });
  it("no name at all is Not complete; customer details still loading is never complete", () => {
    expect(status({ ...ok, customerName: "  ", customer: { ...NO_CUSTOMER_FACTS, loaded: true, available: false } }).customer).toBe("incomplete"); // the typed name counts only where Cin7 lookup is unavailable
    expect(status({ ...ok, customerName: "Typed only", customer: { ...full, hasSnapshot: false, hasContact: false, contactName: null } }).customer).toBe("attention"); // a typed name never replaces the Cin7 customer
    expect(status({ ...ok, customerName: "  " }).customer).toBe("complete"); // a selected Cin7 snapshot IS the identity (no stale "choose the customer")
    expect(status({ ...ok, customer: NO_CUSTOMER_FACTS }).customer).toBe("incomplete");
  });
  it("before the customer snapshot feature exists the typed name is used (matches the Stage 2 handoff, which does not block then)", () => {
    expect(status({ ...ok, customer: { ...NO_CUSTOMER_FACTS, loaded: true, available: false } }).customer).toBe("complete");
  });
  it("site & measurements needs a site name (and valid room measurements)", () => {
    expect(status({ ...ok, siteName: " " }).site).toBe("incomplete");
    expect(status(ok).site).toBe("complete");
  });
  it("room measurement issues put the Site & measurements step in Needs attention and are listed against it; equipment issues against equipment", () => {
    const i: Stage1Input = { ...ok, calcIssues: [{ field: "lengthM", message: "lengthM must be greater than zero." }, { field: "penningRunningMetresPerRoom", message: "penningRunningMetresPerRoom can't be negative." }] };
    const d = deriveStage1Steps(i);
    expect(status(i).site).toBe("attention");
    expect(status(i).equipment).toBe("attention");
    expect(d.issues).toEqual([{ message: "Length must be greater than zero.", stepId: "site" }, { message: "Penning running metres can't be negative.", stepId: "equipment" }]);
    expect(note(i, "site")).toBe("Length must be greater than zero.");
  });
  it("pig size not chosen leaves equipment Not complete (no calculation issue exists for it)", () => {
    expect(status({ ...ok, penningPigSize: null }).equipment).toBe("incomplete");
    expect(status({ ...ok, penningPigSize: undefined }).equipment).toBe("incomplete");
  });
  it("unsupported-selection warnings and Stage 2 quantity issues never mark a Stage 1 step", () => {
    const i: Stage1Input = { ...ok, calcIssues: [{ field: "selectedFeederType", code: "unsupported_selection", message: "x" }, { field: "quantityOverrides.led_light", message: "An override must be a number ≥ 0." }] };
    expect(status(i)).toMatchObject({ site: "complete", equipment: "complete" });
  });
  it("readiness reasons that Stage 1 cannot fix are reported as Stage 2 reasons, not Stage 1 issues", () => {
    const d = deriveStage1Steps({ ...ok, siteName: "", readinessReasons: ["Site / project name is required.", "Feeder: quantity required"] });
    expect(d.issues).toEqual([{ message: "Site / project name is required.", stepId: "site" }]);
    expect(d.stage2Reasons).toEqual(["Feeder: quantity required"]);
  });
  it("missing customer and site produce issues pointing at their own steps", () => {
    const d = deriveStage1Steps({ ...ok, customerName: "", siteName: "", customer: { ...NO_CUSTOMER_FACTS, loaded: true, available: false } });
    expect(d.issues.map((i) => i.stepId)).toEqual(["customer", "site"]);
  });
  it("blank room fields are Not complete (not Needs attention) and use human labels; a real invalid value is Needs attention", () => {
    const blank: Stage1Input = { ...ok, roomValues: { lengthM: 0, widthM: 0 }, calcIssues: [{ field: "lengthM", code: "not_positive", message: "lengthM must be greater than zero." }, { field: "widthM", code: "not_positive", message: "widthM must be greater than zero." }] };
    expect(status(blank).site).toBe("incomplete");
    expect(deriveStage1Steps(blank).issues.map((x) => x.message)).toEqual(["Length must be greater than zero.", "Width must be greater than zero."]);
    const bad: Stage1Input = { ...ok, roomValues: { lengthM: -3 }, calcIssues: [{ field: "lengthM", code: "not_positive", message: "lengthM must be greater than zero." }] };
    expect(status(bad).site).toBe("attention");
    const hosp: Stage1Input = { ...ok, roomValues: {}, calcIssues: [{ field: "hospitalPens", code: "hospital_exceeds_total", message: "Hospital pens can't exceed total pens." }] };
    expect(status(hosp).site).toBe("attention");
  });
  it("a customer-detail read failure is Needs attention with its own note, never 'reading' forever", () => {
    const i = { ...ok, customer: { loaded: true, available: true, hasSnapshot: false, hasContact: false, contactName: null, loadError: true } };
    expect(status(i).customer).toBe("attention");
    expect(note(i, "customer")).toBe("Could not read the Cin7 customer details");
  });
  it("the raw calculation messages still filter out of the Stage 2 reasons after relabelling", () => {
    const d = deriveStage1Steps({ ...ok, calcIssues: [{ field: "lengthM", message: "lengthM must be greater than zero." }], readinessReasons: ["lengthM must be greater than zero.", "Feeder: quantity required"] });
    expect(d.stage2Reasons).toEqual(["Feeder: quantity required"]);
  });
});

describe("ownedWork / open items (UX-006i1): who has to resolve what", () => {
  const work = (over: Partial<NonNullable<Stage1Input["work"]>> = {}): NonNullable<Stage1Input["work"]> => ({ lines: [], budgetLines: [], charges: [], blankExclusionCount: 0, blankPriceReasonCount: 0, ...over });
  it("quantities, the M75 price, override reasons, exclusion reasons and charges are the Rep's; mappings and manual prices are the Estimator's", () => {
    const w = work({
      lines: [{ label: "LED light", basis: "manual_override", exclusionReason: null, overrideState: "manual_override", overrideReason: null }],
      budgetLines: [{ label: "Feeder", status: "no_quantity", reason: "Estimator input required" }, { label: "M75 system", status: "estimator_price_required", reason: "M75 is entered by hand." }, { label: "Cup drinker", status: "unmapped", reason: "x" }, { label: "Door", status: "supplier_quote_required", reason: "x" }],
      charges: [{ label: "Delivery", status: "required" }, { label: "Installation", status: "entered" }], blankExclusionCount: 2, blankPriceReasonCount: 1,
    });
    const o = ownedWork(w);
    expect(o.rep).toEqual(["Feeder: enter the quantity", "M75 system: M75 is entered by hand", "LED light: give the reason for the quantity override", "2 excluded items need a reason", "Delivery: enter the amount"]);
    expect(o.estimator).toEqual(["Estimator product choice needed: Cup drinker", "Estimator product choice needed: Door", "Estimator: 1 manual price needs a reason"]);
  });
  it("Rep-owned work puts Equipment in Needs attention; Estimator-owned work never does (it is named, not blocking the Rep's steps)", () => {
    const rep = deriveStage1Steps({ ...ok, work: work({ budgetLines: [{ label: "Feeder", status: "no_quantity", reason: "r" }] }) });
    expect(rep.steps.find((x) => x.id === "equipment")?.status).toBe("attention");
    expect(rep.open).toEqual([{ message: "Feeder: enter the quantity", owner: "Rep", stepId: "equipment" }]);
    const est = deriveStage1Steps({ ...ok, work: work({ budgetLines: [{ label: "Cup drinker", status: "unmapped", reason: "r" }] }) });
    expect(est.steps.find((x) => x.id === "equipment")?.status).toBe("complete");
    expect(est.open).toEqual([{ message: "Estimator product choice needed: Cup drinker", owner: "Estimator" }]);
  });
  it("customerFactsSettled: loaded, failed or unavailable settle; the initial facts do not", () => {
    expect(customerFactsSettled(NO_CUSTOMER_FACTS)).toBe(false);
    expect(customerFactsSettled({ ...NO_CUSTOMER_FACTS, loaded: true })).toBe(true);
    expect(customerFactsSettled({ ...NO_CUSTOMER_FACTS, loadError: true })).toBe(true);
    expect(customerFactsSettled({ ...NO_CUSTOMER_FACTS, available: false })).toBe(true);
  });
});
