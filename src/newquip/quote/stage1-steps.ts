import type { RailStep, StepStatus } from "@/components/ui/step-rail-model";

// SOLUTION BUILDER STAGE 1 (the Rep's preparation) - pure. Five steps; a step is complete ONLY from data (draft fields, the live calculation's input issues, the readiness reasons,
// the priced lines and the Cin7 customer snapshot) and never because it was visited. This module derives the three CONTENT steps and who owns every open item; the two closing
// steps (Review, Submit) and the locks/entry step are derived by the wizard contract (wizard-contract.ts) from the same facts. Nothing here authorises anything.
//
//   1 Customer & contact   2 Site & measurements   3 Equipment & options   4 Review configuration   5 Submit to Estimator

export type Stage1StepId = "customer" | "site" | "equipment" | "review" | "submit";
export const STAGE1_STEP_IDS: readonly Stage1StepId[] = ["customer", "site", "equipment", "review", "submit"];
export type Stage1ContentStepId = "customer" | "site" | "equipment";
export const STAGE1_STEP_LABEL: Record<Stage1StepId, string> = { customer: "Customer & contact", site: "Site & measurements", equipment: "Equipment & options", review: "Review configuration", submit: "Submit to Estimator" };

/** What the CustomerPanel (which already loads it) reports upward. Nothing is requested for the steps. */
export interface Stage1CustomerFacts {
  /** The panel has finished loading the customer details. */
  loaded: boolean;
  /** Cin7 customer snapshots exist on this deployment (false before the database update: the typed name is then used). */
  available: boolean;
  hasSnapshot: boolean;
  /** A quotation contact is chosen on the snapshot, or a confirmation contact is recorded: what the Stage 2 handoff (ConfirmationPanel) needs besides the snapshot. */
  hasContact: boolean;
  /** The chosen contact's name, for display (null when none). */
  contactName: string | null;
  /** The chosen quotation contact's email = where the quotation is sent (derived from the contact; nothing is stored separately). null when none / not known. */
  contactEmail?: string | null;
  /** The Cin7 trading name (else the Cin7 name) of the selected customer, for the heading. null when none. */
  customerTitle?: string | null;
  /** The customer details could not be read (the panel reports it instead of staying silent). */
  loadError?: boolean;
}
export const NO_CUSTOMER_FACTS: Stage1CustomerFacts = { loaded: false, available: true, hasSnapshot: false, hasContact: false, contactName: null };
/** The customer facts have settled (read, failed, or the feature does not exist): the point after which the entry step may be resolved ONCE. */
export const customerFactsSettled = (c: Stage1CustomerFacts): boolean => c.loaded || c.loadError === true || !c.available;

/** The slices of the live evaluation the owner split needs (all already loaded by the page). */
export interface Stage1WorkFacts {
  /** `ev.calc.lines` (only the fields used). */
  lines: ReadonlyArray<{ label: string; basis: string; exclusionReason: string | null; overrideState: string; overrideReason: string | null }>;
  /** `ev.budget` lines/charges; null when no budget has been computed. */
  budgetLines: ReadonlyArray<{ label: string; status: string; reason: string; pricedBy?: string | null }> | null;
  charges: ReadonlyArray<{ label: string; status: "entered" | "required" }> | null;
  blankExclusionCount: number;
  blankPriceReasonCount: number;
}

export interface Stage1Input {
  customerName: string;
  siteName: string;
  penningPigSize?: string | null;
  /** `ev.calc.issues` (field + message). */
  calcIssues: ReadonlyArray<{ field: string; message: string; code?: string }>;
  /** `ev.readiness.reasons`. */
  readinessReasons: readonly string[];
  customer: Stage1CustomerFacts;
  /** The room fields' current values: a field that is blank (0 / empty) makes the site step Not complete rather than Needs attention. Optional. */
  roomValues?: Partial<Record<string, number | null | undefined>>;
  /** Optional: when given, Rep-owned quantities/charges/exclusions and Estimator-owned mappings/prices are listed (and the Equipment step reflects the Rep's part). */
  work?: Stage1WorkFacts;
}

export interface Stage1Issue { message: string; stepId: Stage1ContentStepId }
/** An open requirement with the role that has to resolve it. `stepId` is the Stage 1 step that fixes it (Rep items only; an Estimator item is resolved in Stage 2). */
export interface OwnedItem { message: string; owner: "Rep" | "Estimator"; stepId?: Stage1ContentStepId }
export interface Stage1Derived {
  steps: Array<RailStep & { id: Stage1ContentStepId }>;
  /** The open Stage 1 reasons, each with the step that fixes it. */
  issues: Stage1Issue[];
  /** Readiness reasons that Stage 1 cannot fix: quantities and prices are now Stage 1 (Rep-owned) too, so this is whatever the owner split could not place. */
  stage2Reasons: string[];
  /** Every open requirement with its owner (Rep items first, in step order). Empty when nothing is outstanding. */
  open: OwnedItem[];
}

const ROOM_FIELDS = new Set(["lengthM", "widthM", "rooms", "totalPens", "hospitalPens", "pigsPerRoom"]);
const EQUIPMENT_FIELDS = new Set(["penningPigSize", "feederVariant", "slattedFloorAreaM2", "penningRunningMetresPerRoom"]);
export const CUSTOMER_REQUIRED_MESSAGE = "Customer name is required.";
export const SITE_REQUIRED_MESSAGE = "Site / project name is required.";
/** Human names for the calculation's field names, for the rail and review notes only (the calculation's own messages are untouched). */
export const FIELD_LABEL: Record<string, string> = {
  lengthM: "Length", widthM: "Width", rooms: "Number of rooms", totalPens: "Total pens", hospitalPens: "Hospital pens", pigsPerRoom: "Pigs per room",
  penningPigSize: "Penning pig size", feederVariant: "CCM feeder variant", slattedFloorAreaM2: "Slatted floor area", penningRunningMetresPerRoom: "Penning running metres",
};
const friendly = (i: { field: string; message: string }) => (i.message.startsWith(i.field) && FIELD_LABEL[i.field] ? FIELD_LABEL[i.field] + i.message.slice(i.field.length) : i.message);
export const NEEDED_BEFORE_ESTIMATOR = "Needed before sending to the Estimator";

/** Budget-line statuses that only an Estimator/Manager can resolve (product mapping, package confirmation, a manual quotation price): the mapping-access rule on the server. */
export const ESTIMATOR_LINE_STATUSES: ReadonlySet<string> = new Set(["unmapped", "package_unconfirmed", "package_incomplete", "not_in_price_source", "supplier_quote_required"]);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Who must resolve what, from the same facts the Stage 2 steps and readiness use. Pure. The Rep's items belong to the Equipment step; the Estimator's are named, never editable by the Rep. */
export function ownedWork(w: Stage1WorkFacts): { rep: string[]; estimator: string[] } {
  const rep: string[] = [];
  const estimator: string[] = [];
  const live = w.lines.filter((l) => l.basis !== "not_selected");
  for (const b of w.budgetLines ?? []) {
    if (b.status === "no_quantity") rep.push(`${b.label}: enter the quantity`);
    else if (b.status === "estimator_price_required") rep.push(`${b.label}: ${b.reason.replace(/\.$/, "")}`);
    else if (ESTIMATOR_LINE_STATUSES.has(b.status)) estimator.push(`Estimator mapping needed: ${b.label}`);
  }
  const noReason = live.filter((l) => l.overrideState === "manual_override" && !l.overrideReason);
  for (const l of noReason) rep.push(`${l.label}: give the reason for the quantity override`);
  if (w.blankExclusionCount > 0) rep.push(`${plural(w.blankExclusionCount, "excluded item needs", "excluded items need")} a reason`);
  for (const c of w.charges ?? []) if (c.status === "required") rep.push(`${c.label}: enter the amount`);
  if (w.blankPriceReasonCount > 0) estimator.push(`Estimator: ${plural(w.blankPriceReasonCount, "manual price needs", "manual prices need")} a reason`);
  return { rep, estimator };
}

export function deriveStage1Steps(input: Stage1Input): Stage1Derived {
  const issues: Stage1Issue[] = [];
  const named = input.customerName.trim().length > 0;
  const sited = input.siteName.trim().length > 0;
  if (!named) issues.push({ message: CUSTOMER_REQUIRED_MESSAGE, stepId: "customer" });
  if (!sited) issues.push({ message: SITE_REQUIRED_MESSAGE, stepId: "site" });
  const roomIssues = input.calcIssues.filter((i) => ROOM_FIELDS.has(i.field) && i.code !== "unsupported_selection");
  const equipmentIssues = input.calcIssues.filter((i) => EQUIPMENT_FIELDS.has(i.field) && i.code !== "unsupported_selection");
  for (const i of roomIssues) issues.push({ message: friendly(i), stepId: "site" });
  for (const i of equipmentIssues) issues.push({ message: friendly(i), stepId: "equipment" });
  const rawHandled = [...issues.filter((x) => x.stepId === "customer" || (x.stepId === "site" && x.message === SITE_REQUIRED_MESSAGE)).map((x) => x.message), ...roomIssues.map((i) => i.message), ...equipmentIssues.map((i) => i.message)];
  const blank = (f: string) => { const v = input.roomValues?.[f]; return !v; };
  const roomJustBlank = !!input.roomValues && roomIssues.length > 0 && roomIssues.every((i) => i.code === "not_positive" && blank(i.field));
  const pigSizeMissing = input.penningPigSize == null || input.penningPigSize === "";

  const c = input.customer;
  let customer: { status: StepStatus; note?: string };
  if (!named) customer = { status: "incomplete" };
  else if (c.loadError) customer = { status: "attention", note: "Could not read the Cin7 customer details" };
  else if (!c.loaded) customer = { status: "incomplete", note: "Reading the Cin7 customer details…" };
  else if (!c.available) customer = { status: "complete", note: "Cin7 customer lookup is not available yet; the typed name is used" };
  else if (!c.hasSnapshot) customer = { status: "attention", note: NEEDED_BEFORE_ESTIMATOR };
  else if (!c.hasContact) customer = { status: "attention", note: "Choose the quotation contact. Needed before sending to the Estimator" };
  else customer = { status: "complete" };

  // Site & measurements: the site name plus the room measurements (length, width, rooms, pens, pigs).
  let site: { status: StepStatus; note?: string };
  if (roomJustBlank) site = { status: "incomplete", note: "Enter the room measurements" };
  else if (roomIssues.length > 0) site = { status: "attention", note: friendly(roomIssues[0]) };
  else if (!sited) site = { status: "incomplete" };
  else site = { status: "complete" };

  const owned = input.work ? ownedWork(input.work) : { rep: [], estimator: [] };
  let equipment: { status: StepStatus; note?: string };
  if (equipmentIssues.length > 0) equipment = { status: "attention", note: friendly(equipmentIssues[0]) };
  else if (pigSizeMissing) equipment = { status: "incomplete", note: "Choose the penning pig size" };
  else if (owned.rep.length > 0) equipment = { status: "attention", note: owned.rep[0] + (owned.rep.length > 1 ? ` (+${owned.rep.length - 1} more)` : "") };
  else equipment = { status: "complete" };

  const handled = new Set(rawHandled);
  const stage2Reasons = input.readinessReasons.filter((r) => !handled.has(r));
  const settledCustomer = !c.loadError && c.loaded && c.available;
  const open: OwnedItem[] = [
    ...issues.map((i) => ({ message: i.message, owner: "Rep" as const, stepId: i.stepId })),
    ...(settledCustomer && named && !c.hasSnapshot ? [{ message: "Select the customer from Cin7", owner: "Rep" as const, stepId: "customer" as const }] : []),
    ...(settledCustomer && c.hasSnapshot && !c.hasContact ? [{ message: "Choose the quotation contact", owner: "Rep" as const, stepId: "customer" as const }] : []),
    ...(pigSizeMissing && equipmentIssues.length === 0 ? [{ message: "Choose the penning pig size", owner: "Rep" as const, stepId: "equipment" as const }] : []),
    ...owned.rep.map((message) => ({ message, owner: "Rep" as const, stepId: "equipment" as const })),
    ...owned.estimator.map((message) => ({ message, owner: "Estimator" as const })),
  ];

  const mk = (id: Stage1ContentStepId, s: { status: StepStatus; note?: string }) => ({ id, label: STAGE1_STEP_LABEL[id], status: s.status, ...(s.note ? { note: s.note } : {}) });
  return { steps: [mk("customer", customer), mk("site", site), mk("equipment", equipment)], issues, stage2Reasons, open };
}

/** Inline messages for the Stage 1 fields, keyed by the calculation's field name (plus `siteName` and `penningPigSize`). Human wording only; the page decides WHEN to show each (after the field was touched or the viewer left the step). */
export function fieldErrors(i: Pick<Stage1Input, "siteName" | "penningPigSize" | "calcIssues">): Record<string, string> {
  const out: Record<string, string> = {};
  if (!i.siteName.trim()) out.siteName = SITE_REQUIRED_MESSAGE;
  for (const c of i.calcIssues) if ((ROOM_FIELDS.has(c.field) || EQUIPMENT_FIELDS.has(c.field)) && c.code !== "unsupported_selection" && !out[c.field]) out[c.field] = friendly(c);
  if ((i.penningPigSize == null || i.penningPigSize === "") && !out.penningPigSize) out.penningPigSize = "Choose the penning pig size.";
  return out;
}
/** The field keys (see fieldErrors) that live on each Stage 1 content step: leaving the step marks them touched. */
export const STEP_FIELD_KEYS: Record<Stage1ContentStepId, readonly string[]> = {
  customer: [], site: ["siteName", "lengthM", "widthM", "rooms", "totalPens", "hospitalPens", "pigsPerRoom"], equipment: ["penningPigSize", "feederVariant", "slattedFloorAreaM2", "penningRunningMetresPerRoom"],
};
