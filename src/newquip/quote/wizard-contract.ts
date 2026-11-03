import type { StepStatus } from "@/components/ui/step-rail-model";
import { STAGE1_STEP_IDS, STAGE1_STEP_LABEL, type OwnedItem, type Stage1CustomerFacts, type Stage1Derived, type Stage1StepId } from "./stage1-steps";
import type { StageStatus } from "./stages";

// THE WIZARD CONTRACT (pure). One place that answers, for the signed-in viewer and the quotation as it is now: which steps exist, who owns each, whether the viewer may EDIT it, only
// read it, or cannot open it yet (LOCKED), WHY it is locked (human reasons that name the responsible role), and which step the wizard should OPEN at.
//
// It imports no server action, no store and no React: it only CONSUMES derivations the page already has (deriveStage1Steps, the readiness result, the customer facts, the quotation's
// state/revision, the viewer's roles and cost visibility, and computeStages' status for the stage). It introduces NO business gate. Two kinds of lock exist and the step says which:
//   "server"  a gate the server really enforces (sendGrowerQuoteToEstimatorAction -> sendToEstimator): a Cin7 customer snapshot, a chosen contact, readiness READY, a total, and
//             (inside the Submit step) the confirmation contact. Marked real.
//   "policy"  the owner's UX sequencing for Stage 1 (step 2 after 1, 3 after 2, Review after 3, Submit after Review). Nothing server-side requires it; it is guidance.
// A locked step NEVER blocks Back or the rail to a PERMITTED earlier step, and a locked future step shows its blocker. Role enforcement stays in the server actions.
//
// ── API (for stages 2 and 3, which reuse the same types and helpers) ──
//   deriveWizard(input)            -> { steps: WizardStep[], entryStepId, returned, nextOwner, submitted }   (Stage 1 today)
//   WizardStep                     -> { id, label, owner, status, access, blockedBy[], blockKind?, note? }
//   isPermitted(step)              -> access is "edit" or "readonly" (the viewer may open it)
//   resolveEntryStep(wizard, req?) -> an explicit request wins only if permitted; else the entry step
//   currentStepId(steps, wanted)   -> `wanted` if permitted, else the nearest earlier permitted step (a step that became locked never strands the viewer)
//   toRailSteps(steps)             -> RailStep[] for the shared StepRail (locked / blockedBy carried over)
// Stage 2 / Stage 3 (stage23-wizard.ts) return WizardStep<their id>[] of the same shape (owner "Estimator" / "Manager") and reuse the helpers above unchanged; a "hidden" step is left off the rail.

export type WizardRole = "Rep" | "Estimator" | "Manager";
export type WizardStepId = Stage1StepId;
export type WizardAccess = "edit" | "readonly" | "hidden" | "locked";
/** The step shape is shared by all stages: `I` is the stage's own step id (Stage 1 by default; Stage 2 and 3 use theirs, see stage23-wizard.ts). */
export interface WizardStep<I extends string = WizardStepId> {
  id: I; label: string;
  /** The role whose work this step is. */
  owner: WizardRole;
  /** Derived from data only (never from a visit). */
  status: StepStatus;
  /** edit: the viewer owns and can act in it (Review and Submit are the Rep's steps even though Review's own content is read-only). readonly: the viewer may inspect it. hidden: not shown to this viewer. locked: cannot be opened yet. */
  access: WizardAccess;
  /** Why it is locked, in words that name the responsible role. Empty unless access is "locked". */
  blockedBy: string[];
  /** For a locked step: whether the gate is one the server enforces ("server") or the owner's UX sequencing ("policy"). */
  blockKind?: "server" | "policy";
  /** A short line for the rail (data-derived note or, for a non-editor, who has the work). */
  note?: string;
  /** Optional (Stage 2): the step counts as done in the rail's totals although its status is not "complete" (e.g. a Final review that has been marked reviewed), with the visible label to show. Carried to the rail unchanged. */
  counted?: boolean; statusLabel?: string;
}

export interface WizardInput {
  state: "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL";
  revision: number;
  /** computeStages(...)[0].status: RETURNED means the quotation was returned to the Rep (state REP_DRAFT with revision > 1). */
  stage1Status: StageStatus;
  /** The viewer's roles (a Manager/Administrator observer may hold none of rep/estimator). */
  roles: { rep: boolean; estimator: boolean; manager: boolean };
  /** The viewer may see cost and margin (an Estimator/Manager or an Administrator observer). Carried for Stage 2/3; Stage 1 shows no cost to anyone. */
  canViewCommercials: boolean;
  /** deriveStage1Steps(...): the data-derived status of Customer, Site and Equipment, and every open item with its owner. */
  stage1: Stage1Derived;
  customer: Stage1CustomerFacts;
  readiness: { state: "DRAFT" | "BLOCKED" | "READY" };
  /** The quote total (ex VAT) is available (> 0). */
  totalAvailable: boolean;
}

export interface Wizard<I extends string = WizardStepId> {
  steps: WizardStep<I>[];
  /** The step the wizard opens at: the first incomplete step the viewer may act on (or, for a viewer who cannot edit, the summary). */
  entryStepId: I;
  /** REP_DRAFT with revision > 1: the Estimator/Manager returned it. The page shows a banner and opens at the first incomplete step. */
  returned: boolean;
  /** The Rep's preparation is done and the quotation is with the next role. */
  submitted: boolean;
  /** Who is responsible for the next action on the quotation right now. */
  nextOwner: WizardRole;
}

export const isPermitted = (s: Pick<WizardStep, "access">): boolean => s.access === "edit" || s.access === "readonly";
const OWNER: Record<WizardStepId, WizardRole> = { customer: "Rep", site: "Rep", equipment: "Rep", review: "Rep", submit: "Rep" };

/** The first incomplete step the viewer may act on; with none, the last step they can open that is incomplete; with no editable step at all, the summary. */
function entryOf(steps: readonly WizardStep[], submitted: boolean): WizardStepId {
  const editable = steps.filter((s) => s.access === "edit");
  if (editable.length === 0) return submitted ? "submit" : "review";
  const open = editable.find((s) => s.status !== "complete");
  if (open) return open.id;
  // Everything the viewer can act on is complete but a later step is still locked (e.g. waiting on the Estimator): stay on the last step they can act on.
  const lockedOpen = steps.some((s) => s.access === "locked" && s.status !== "complete");
  return lockedOpen ? editable[editable.length - 1].id : editable[0].id;
}

export function deriveWizard(i: WizardInput): Wizard {
  const final = i.state === "MANAGER_APPROVED_FINAL";
  const inReview = i.state === "ESTIMATOR_REVIEW";
  const returned = i.stage1Status === "RETURNED";
  const submitted = inReview || final;
  // Stage 1 is the Rep's: only a Rep, on a quotation that is still a Rep draft, edits it. An Estimator or Manager (or an observer) inspects it read-only; after submission it is read-only for everyone.
  const canEdit = i.state === "REP_DRAFT" && i.roles.rep;
  const c = i.customer;
  const byId = new Map(i.stage1.steps.map((s) => [s.id, s]));
  const content = (id: "customer" | "site" | "equipment") => byId.get(id)!;
  const repOpen = i.stage1.open.filter((o) => o.owner === "Rep");
  const estimatorOpen = i.stage1.open.filter((o) => o.owner === "Estimator");

  // Statuses (data only).
  const first3Complete = (["customer", "site", "equipment"] as const).every((id) => content(id).status === "complete");
  const reviewStatus: StepStatus = first3Complete && repOpen.length === 0 ? "complete" : "incomplete";
  // The server's Submit gates (checkHandoff / sendToEstimator): snapshot + chosen contact + READY + total. Where the snapshot feature does not exist the typed name is used and no snapshot is needed.
  const serverBlocks: string[] = [];
  if (c.loaded && c.available && !c.hasSnapshot) serverBlocks.push("Rep: select the Cin7 customer in step 1.");
  if (c.loaded && c.available && c.hasSnapshot && !c.hasContact) serverBlocks.push("Rep: choose the quotation contact in step 1.");
  if (i.readiness.state !== "READY") {
    if (estimatorOpen.length > 0) serverBlocks.push(`Estimator: ${estimatorOpen[0].message.replace(/^Estimator:?\s*/, "")}${estimatorOpen.length > 1 ? ` (+${estimatorOpen.length - 1} more)` : ""}. The quotation can be submitted once the Estimator has done this.`);
    else serverBlocks.push("The quotation must be complete (nothing outstanding) before it can be submitted.");
  } else if (!i.totalAvailable) serverBlocks.push("The quotation total is not available yet.");
  const submitStatus: StepStatus = submitted ? "complete" : "incomplete";

  const status: Record<WizardStepId, StepStatus> = { customer: content("customer").status, site: content("site").status, equipment: content("equipment").status, review: reviewStatus, submit: submitStatus };
  const baseNote = (id: WizardStepId): string | undefined => {
    if (id === "review") return first3Complete ? (estimatorOpen.length > 0 ? `${estimatorOpen.length} item${estimatorOpen.length === 1 ? "" : "s"} waiting on the Estimator` : undefined) : "Finish the earlier steps";
    if (id === "submit") return submitted ? "Rep preparation complete - next: Estimator" : returned ? "Returned: reconfirm the amount with the customer" : undefined;
    return content(id).note;
  };

  const steps: WizardStep[] = STAGE1_STEP_IDS.map((id, idx): WizardStep => {
    const base = { id, label: STAGE1_STEP_LABEL[id], owner: OWNER[id], status: status[id], note: baseNote(id) };
    if (!canEdit) {
      // A viewer who cannot edit inspects every step read-only; there is nothing to unlock. They are told whose work it is.
      const who = submitted ? "Submitted by the Rep" : i.roles.rep ? "Read-only" : "With the Rep";
      return { ...base, access: "readonly", blockedBy: [], note: id === "submit" ? baseNote(id) ?? (submitted ? undefined : "Not submitted yet") : base.note ?? (id === "customer" ? who : undefined) };
    }
    // UX POLICY: a step opens only when the steps before it are complete (2 after 1, 3 after 2, Review after 3, Submit after Review).
    for (let j = 0; j < idx; j++) {
      const prev = STAGE1_STEP_IDS[j];
      if (status[prev] === "complete") continue;
      // Reasons are derived from the CURRENT facts: only what is still missing is named.
      const why = prev === "customer" ? (c.loadError ? "the customer details could not be read; reload the page" : c.loaded && c.available && c.hasSnapshot && !c.hasContact ? "choose the quotation contact" : c.loaded && c.available && !c.hasSnapshot ? "choose the Cin7 customer" : "choose the Cin7 customer and the quotation contact") : prev === "site" ? "enter the site name and room measurements" : prev === "equipment" ? "finish the equipment selections and quantities" : "review the configuration";
      // The step right after the open one says what to do; later steps only point back at it (shorter, less repetition).
      const text = j === idx - 1 ? `Rep: ${why} in step ${j + 1} (${STAGE1_STEP_LABEL[prev]}) first.` : `Rep: complete step ${j + 1} (${STAGE1_STEP_LABEL[prev]}) first.`;
      return { ...base, access: "locked", blockedBy: [text], blockKind: "policy" };
    }
    // SERVER GATES for Submit (real): see above.
    if (id === "submit" && serverBlocks.length > 0) return { ...base, access: "locked", blockedBy: serverBlocks, blockKind: "server" };
    return { ...base, access: "edit", blockedBy: [] };
  });

  const entryStepId = entryOf(steps, submitted);
  // Once submitted the Estimator is next (a sign-off then makes the Manager next; that is Stage 2/3 knowledge, not Stage 1's). The Manager only has the quotation once it is final.
  const nextOwner: WizardRole = final ? "Manager" : inReview ? "Estimator" : "Rep";
  return { steps, entryStepId, returned, submitted, nextOwner };
}

/** An explicit request (e.g. ?step=) wins only if that step is permitted; otherwise the entry step. */
export function resolveEntryStep<I extends string = WizardStepId>(w: Pick<Wizard<I>, "steps" | "entryStepId">, requested?: I | null): I {
  const r = requested ? w.steps.find((s) => s.id === requested) : undefined;
  return r && isPermitted(r) ? r.id : w.entryStepId;
}

/** The step to show: `wanted` if the viewer may open it, else the nearest EARLIER permitted step (a step that became locked after an edit upstream never strands them), else the first permitted. */
export function currentStepId<I extends string = WizardStepId>(steps: readonly WizardStep<I>[], wanted: I): I {
  const at = steps.findIndex((s) => s.id === wanted);
  if (at >= 0 && isPermitted(steps[at])) return wanted;
  for (let k = Math.max(at, 0); k >= 0; k--) if (isPermitted(steps[k])) return steps[k].id;
  return (steps.find(isPermitted) ?? steps[0]).id;
}

/** The shared StepRail's steps for a contract result (locked/blockedBy carried over; a locked step is not selectable there). */
export function toRailSteps<I extends string = WizardStepId>(steps: readonly WizardStep<I>[]): Array<{ id: I; label: string; status: StepStatus; note?: string; counted?: boolean; statusLabel?: string; locked?: boolean; blockedBy?: string[] }> {
  // A step that is "hidden" for this viewer (e.g. the cost steps for a viewer without cost visibility) is not on the rail at all: absent, not disabled.
  return steps.filter((s) => s.access !== "hidden").map((s) => ({ id: s.id, label: s.label, status: s.status, ...(s.note ? { note: s.note } : {}), ...(s.counted ? { counted: true } : {}), ...(s.statusLabel ? { statusLabel: s.statusLabel } : {}), ...(s.access === "locked" ? { locked: true, blockedBy: s.blockedBy } : {}) }));
}

/** A Rep-owned item can be fixed by the viewer only when they may edit and the step is open; otherwise the owner is just named. */
export const itemLinkable = (o: OwnedItem, steps: readonly WizardStep[]): boolean => !!o.stepId && o.owner === "Rep" && steps.find((s) => s.id === o.stepId)?.access === "edit";
