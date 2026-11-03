import type { RailStep, StepStatus } from "@/components/ui/step-rail-model";

// SOLUTION BUILDER STAGE 1 STEPS (pure). Five steps over the panels that already exist; a step is complete ONLY from data (draft fields, the live calculation's input issues,
// the readiness reasons and the Cin7 customer snapshot) and never because it was visited. Nothing here gates navigation or authorises anything.
//
//   1 Select customer   2 Contact & site name   3 Room measurements   4 Equipment & options   5 Review configuration

export type Stage1StepId = "customer" | "site" | "room" | "equipment" | "review";
export const STAGE1_STEP_IDS: readonly Stage1StepId[] = ["customer", "site", "room", "equipment", "review"];
export const STAGE1_STEP_LABEL: Record<Stage1StepId, string> = { customer: "Select customer", site: "Contact & site name", room: "Room measurements", equipment: "Equipment & options", review: "Review configuration" };

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
}
export const NO_CUSTOMER_FACTS: Stage1CustomerFacts = { loaded: false, available: true, hasSnapshot: false, hasContact: false, contactName: null };

export interface Stage1Input {
  customerName: string;
  siteName: string;
  penningPigSize?: string | null;
  /** `ev.calc.issues` (field + message). */
  calcIssues: ReadonlyArray<{ field: string; message: string; code?: string }>;
  /** `ev.readiness.reasons`. */
  readinessReasons: readonly string[];
  customer: Stage1CustomerFacts;
}

export interface Stage1Issue { message: string; stepId: Stage1StepId }
export interface Stage1Derived {
  steps: Array<RailStep & { id: Stage1StepId }>;
  /** The open Stage 1 reasons, each with the step that fixes it. */
  issues: Stage1Issue[];
  /** Readiness reasons that Stage 1 cannot fix (priced lines, mappings, quantities): they belong to Stage 2. */
  stage2Reasons: string[];
}

const ROOM_FIELDS = new Set(["lengthM", "widthM", "rooms", "totalPens", "hospitalPens", "pigsPerRoom"]);
const EQUIPMENT_FIELDS = new Set(["penningPigSize", "feederVariant", "slattedFloorAreaM2", "penningRunningMetresPerRoom"]);
export const CUSTOMER_REQUIRED_MESSAGE = "Customer name is required.";
export const SITE_REQUIRED_MESSAGE = "Site / project name is required.";
export const NEEDED_BEFORE_ESTIMATOR = "Needed before sending to the Estimator";

export function deriveStage1Steps(input: Stage1Input): Stage1Derived {
  const issues: Stage1Issue[] = [];
  const named = input.customerName.trim().length > 0;
  const sited = input.siteName.trim().length > 0;
  if (!named) issues.push({ message: CUSTOMER_REQUIRED_MESSAGE, stepId: "customer" });
  if (!sited) issues.push({ message: SITE_REQUIRED_MESSAGE, stepId: "site" });
  const roomIssues = input.calcIssues.filter((i) => ROOM_FIELDS.has(i.field) && i.code !== "unsupported_selection");
  const equipmentIssues = input.calcIssues.filter((i) => EQUIPMENT_FIELDS.has(i.field) && i.code !== "unsupported_selection");
  for (const i of roomIssues) issues.push({ message: i.message, stepId: "room" });
  for (const i of equipmentIssues) issues.push({ message: i.message, stepId: "equipment" });
  const pigSizeMissing = input.penningPigSize == null || input.penningPigSize === "";

  const c = input.customer;
  let customer: { status: StepStatus; note?: string };
  if (!named) customer = { status: "incomplete" };
  else if (!c.loaded) customer = { status: "incomplete", note: "Reading the Cin7 customer details…" };
  else if (!c.available) customer = { status: "complete", note: "Cin7 customer lookup is not available yet; the typed name is used" };
  else if (!c.hasSnapshot) customer = { status: "attention", note: NEEDED_BEFORE_ESTIMATOR };
  else if (!c.hasContact) customer = { status: "attention", note: "Choose the quotation contact. Needed before sending to the Estimator" };
  else customer = { status: "complete" };

  const site: { status: StepStatus; note?: string } = sited ? { status: "complete" } : { status: "incomplete" };
  const room: { status: StepStatus; note?: string } = roomIssues.length > 0 ? { status: "attention", note: roomIssues[0].message } : { status: "complete" };
  const equipment: { status: StepStatus; note?: string } = equipmentIssues.length > 0 ? { status: "attention", note: equipmentIssues[0].message }
    : pigSizeMissing ? { status: "incomplete", note: "Choose the penning pig size" } : { status: "complete" };

  const handled = new Set(issues.map((i) => i.message));
  const stage2Reasons = input.readinessReasons.filter((r) => !handled.has(r));
  const allBefore = [customer, site, room, equipment].every((s) => s.status === "complete");
  const review: { status: StepStatus; note?: string } = allBefore && issues.length === 0 ? { status: "complete" } : { status: "incomplete" };

  const mk = (id: Stage1StepId, s: { status: StepStatus; note?: string }) => ({ id, label: STAGE1_STEP_LABEL[id], status: s.status, ...(s.note ? { note: s.note } : {}) });
  return { steps: [mk("customer", customer), mk("site", site), mk("room", room), mk("equipment", equipment), mk("review", review)], issues, stage2Reasons };
}
