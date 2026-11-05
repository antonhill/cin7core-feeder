import type { RailStep, StepStatus } from "@/components/ui/step-rail-model";

// SOLUTION BUILDER STAGE 2 STEPS (pure). Two RESPONSIBILITY GROUPS over the panels that already exist; a step is complete ONLY from data the page has already loaded (the readiness
// result, the budget, the draft's own validation and the quotation's own workflow fields) and never because it was visited. Nothing here gates navigation or authorises anything:
// the action buttons keep their own disabled reasons and the server re-checks every action.
//
//   REP PREPARATION     1 Lines & mappings   2 Charges & prices   3 Submit to Estimator (the Rep's existing "record the price confirmation and send" action)
//   ESTIMATOR REVIEW    4 Cost & margin (only for a viewer who may see commercials)   5 Sign-off or return (the existing Estimator sign-off / return actions)
//
// Three different things are kept apart in the wording: CALCULATION readiness (readiness.state: is the quote complete enough to price), WORKFLOW (the quotation's state and
// confirmation / sign-off records: who has to act next) and APPROVAL (Manager, Stage 3). The workflow facts used here, and what proves them:
//   submitted            state ESTIMATOR_REVIEW (sendToEstimator sets it together with customer_confirmed_* and handoff_by_email; quote-store.ts)
//   returned to the Rep  state REP_DRAFT with revision > 1 (returnToRep / a customer change bump the revision and clear the confirmation; stages.ts "returned")
//   signed off           estimator_signoff_hash equals draft_hash (a stale hash means the content changed after sign-off)
//   approved             state MANAGER_APPROVED_FINAL
// There is NO stored state for "the Estimator has opened it / is reviewing it", so the Estimator side says "Awaiting Estimator review", never "in progress".

export type Stage2StepId = "lines" | "charges" | "submit" | "cost" | "signoff";
export type Stage2GroupId = "rep" | "estimator";
export const STAGE2_STEP_LABEL: Record<Stage2StepId, string> = { lines: "Lines & mappings", charges: "Charges & prices", submit: "Submit to Estimator", cost: "Cost & margin", signoff: "Sign-off or return" };
export const STAGE2_GROUP_LABEL: Record<Stage2GroupId, string> = { rep: "Rep preparation", estimator: "Estimator review" };
export const STAGE2_STEP_GROUP: Record<Stage2StepId, Stage2GroupId> = { lines: "rep", charges: "rep", submit: "rep", cost: "estimator", signoff: "estimator" };

/** The steps this viewer has. A viewer who may not see commercials has no Cost & margin step at all (absent, not hidden). */
export const stage2StepIds = (canViewCommercials: boolean): Stage2StepId[] => (canViewCommercials ? ["lines", "charges", "submit", "cost", "signoff"] : ["lines", "charges", "submit", "signoff"]);

type QuoteStateName = "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL";
type BridgeStatus = string;
export type GroupTone = "success" | "warning" | "info" | "neutral" | "danger";

export interface Stage2Input {
  canViewCommercials: boolean;
  /** The viewer's roles. A Manager has oversight of both groups. */
  roles: { rep: boolean; estimator: boolean; manager: boolean };
  /** The viewer may edit the draft (a Rep or Estimator, quote not final). The Rep's steps are only theirs to do when they can. */
  editable: boolean;
  state: QuoteStateName;
  revision: number;
  /** The live calculation accepted the Stage 1 inputs; when false there are no lines to decide yet. */
  calcValid: boolean;
  /** `ev.calc.lines` (only the fields used). */
  lines: ReadonlyArray<{ basis: string; exclusionReason: string | null; inputRequired: string | null; overrideState: string; overrideReason: string | null }>;
  readiness: { state: "DRAFT" | "BLOCKED" | "READY"; reasons: readonly string[]; missingMappings: number };
  /** `ev.budget` facts; null when no budget has been computed (nothing priced yet). */
  budget: null | {
    incomplete: boolean; estimatedCost: number; marginPct: number | null;
    lines: ReadonlyArray<{ status: BridgeStatus; pricedBy?: string | null }>;
    charges: ReadonlyArray<{ label: string; status: "entered" | "required" }>;
  };
  /** The same predicates `saveWhy` uses, plus blank manual-price reasons. */
  blankExclusionCount: number;
  incompleteCostOverrideCount: number;
  blankPriceReasonCount: number;
  /** The total the Rep would confirm (null when it is not available yet). */
  totalAvailable: boolean;
  confirmedRecorded: boolean;
  signoff: "none" | "current" | "stale";
  /** The viewer has marked the costing reviewed for THIS version (client-local, never a sign-off; the page invalidates it on any save, revision, unsaved edit or costing-total change). */
  costAcknowledged: boolean;
  /** The page has unsaved edits (saving them would make a current sign-off stale). */
  dirty: boolean;
}

export type Stage2Step = RailStep & { id: Stage2StepId; group: Stage2GroupId };
export interface Stage2Group {
  id: Stage2GroupId; label: string;
  /** The truthful workflow line for this group, from the quotation's own state and records. */
  statusLine: string; tone: GroupTone;
  stepIds: Stage2StepId[];
  complete: number; total: number; attention: number;
  /** "2 of 3 complete" over THIS group's steps only. */
  progress: string;
}
export interface Stage2Derived {
  steps: Stage2Step[];
  groups: Stage2Group[];
  /** Steps that are this viewer's to do right now (their group, and not just waiting on someone else). Used for "Next incomplete step". */
  actionable: Set<Stage2StepId>;
}

type Result = { status: StepStatus; note?: string; waiting?: boolean };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function deriveStage2Steps(i: Stage2Input): Stage2Derived {
  const finishStage1 = (): Result => ({ status: "incomplete", note: "Finish the Stage 1 configuration first" });
  const live = i.lines.filter((l) => l.basis !== "not_selected");
  const final = i.state === "MANAGER_APPROVED_FINAL";
  const inReview = i.state === "ESTIMATOR_REVIEW";
  const returned = i.state === "REP_DRAFT" && i.revision > 1;

  let lines: Result;
  if (!i.calcValid) lines = finishStage1();
  else {
    const pending = live.filter((l) => !l.exclusionReason && l.inputRequired != null).length;
    const noReason = live.filter((l) => l.overrideState === "manual_override" && !l.overrideReason).length;
    const open: string[] = [];
    if (i.readiness.missingMappings > 0) open.push(plural(i.readiness.missingMappings, "mapping to confirm", "mappings to confirm"));
    if (pending > 0) open.push(plural(pending, "quantity to enter", "quantities to enter"));
    if (noReason > 0) open.push(plural(noReason, "override reason missing", "override reasons missing"));
    lines = open.length > 0 ? { status: "attention", note: open.join(" · ") } : { status: "complete" };
  }

  let charges: Result;
  if (!i.calcValid) charges = finishStage1();
  else if (i.budget == null) charges = { status: "incomplete", note: "Nothing is priced yet" };
  else {
    const open: string[] = [];
    if (i.blankExclusionCount > 0) open.push(plural(i.blankExclusionCount, "excluded item needs a reason", "excluded items need a reason"));
    if (i.blankPriceReasonCount > 0) open.push(plural(i.blankPriceReasonCount, "manual price needs a reason", "manual prices need a reason"));
    const unpriced = i.budget.lines.filter((b) => b.status === "not_in_price_source" || b.status === "supplier_quote_required" || b.status === "estimator_price_required").length;
    if (unpriced > 0) open.push(plural(unpriced, "line needs a price", "lines need a price"));
    const chargesOpen = i.budget.charges.filter((c) => c.status === "required").length;
    if (chargesOpen > 0) open.push(plural(chargesOpen, "charge not entered", "charges not entered"));
    charges = open.length > 0 ? { status: "attention", note: open.join(" · ") } : { status: "complete" };
  }

  // The Rep's own final action. Submitted is proven by the workflow state, never inferred from complete Rep data.
  let submit: Result;
  if (final) submit = { status: "complete", note: "Submitted and approved" };
  else if (inReview) submit = { status: "complete", note: "Submitted: the price confirmation is recorded" };
  else if (i.readiness.state !== "READY") submit = { status: "attention", note: "The quote must be READY before the price can be confirmed" };
  else if (!i.totalAvailable) submit = { status: "attention", note: "The quote total is not available yet" };
  else submit = { status: "incomplete", note: returned ? "Returned: reconfirm the amount with the customer" : "Ready for the price confirmation" };

  let cost: Result;
  if (!i.canViewCommercials) cost = { status: "unavailable" };
  else if (!i.calcValid || i.budget == null) cost = { status: "incomplete", note: "Cost figures are not available yet" };
  else if (i.incompleteCostOverrideCount > 0) cost = { status: "attention", note: plural(i.incompleteCostOverrideCount, "cost override is incomplete", "cost overrides are incomplete") };
  else if (i.budget.incomplete) cost = { status: "attention", note: "The estimate is partial until every blocker is resolved" };
  else if (i.budget.marginPct == null) cost = { status: "attention", note: "The margin is not available" };
  else if (final) cost = { status: "complete" };
  // The Cin7 cost-capture state lives inside the Cost panel and is not read here, so a green check would claim more than is known: a neutral Review.
  else cost = { status: "review", note: "Cin7 cost capture is checked in the Cost panel" };

  // The Estimator's decision. "Awaiting" is all the data can say: nothing records that an Estimator has opened the quote.
  let signoff: Result;
  const youEstimate = i.roles.estimator;
  if (final) signoff = { status: "complete", note: "Approved" };
  else if (!inReview) signoff = { status: "incomplete", note: returned ? `Returned to the Rep (revision ${i.revision})` : "Waiting for the Rep to submit", waiting: true };
  else if (i.signoff === "current" && i.dirty) signoff = { status: "attention", note: "Unsaved edits: saving makes the sign-off stale" };
  else if (i.signoff === "current") signoff = { status: "complete", note: "Estimator sign-off is current" };
  else if (i.signoff === "stale") signoff = { status: "attention", note: "The sign-off no longer matches the quotation" };
  else if (i.readiness.state !== "READY") signoff = { status: "attention", note: "The quote must be READY before it can be signed off" };
  else signoff = { status: "incomplete", note: youEstimate ? "Awaiting your review" : "Awaiting Estimator review" };

  const all: Record<Stage2StepId, Result> = { lines, charges, submit, cost, signoff };
  // A step in the OTHER role's group is shown for reference only: "Needs attention" is reserved for the viewer's own work (a Manager has oversight of both), so it reads Not complete.
  const owns = (g: Stage2GroupId) => i.roles.manager || (g === "rep" ? i.roles.rep : i.roles.estimator);
  const shown = (id: Stage2StepId): StepStatus => (all[id].status === "attention" && !owns(STAGE2_STEP_GROUP[id]) ? "incomplete" : all[id].status);
  // Once the Estimator's sign-off on THIS content is current the Review step has been reviewed: it counts as done (no check glyph, the label stays "Review needed").
  // Another role's unfinished Rep work reads as "Waiting on the Rep" to an Estimator (no cost wording).
  const note = (id: Stage2StepId): string | undefined => (STAGE2_STEP_GROUP[id] === "rep" && !owns("rep") && !inReview && !final && all[id].status !== "complete" ? "Waiting on the Rep" : all[id].note);
  const reviewed = inReview && i.signoff === "current" && !i.dirty;
  // A client-local acknowledgement by an Estimator/Manager who can see commercials. It only moves the Review step to "Reviewed"; the sign-off is a separate action and the group line never claims it.
  const acknowledged = inReview && i.costAcknowledged && !i.dirty && i.canViewCommercials && (i.roles.estimator || i.roles.manager) && i.signoff !== "current";
  const steps: Stage2Step[] = stage2StepIds(i.canViewCommercials).map((id) => ({ id, label: STAGE2_STEP_LABEL[id], status: shown(id), group: STAGE2_STEP_GROUP[id], ...(id === "cost" && all.cost.status === "review" && (reviewed || acknowledged) ? { counted: true, statusLabel: "Reviewed" } : {}), ...(id === "cost" && all.cost.status === "review" && acknowledged ? { note: "You marked this reviewed - this is not a sign-off; it is not saved" } : note(id) ? { note: note(id) } : {}) }));

  // ── group status lines (workflow facts only) ──
  const repPrepDone = lines.status === "complete" && charges.status === "complete" && i.readiness.state === "READY";
  let rep: { line: string; tone: GroupTone };
  if (final) rep = { line: "Approved", tone: "success" };
  else if (inReview && i.signoff === "current") rep = { line: i.dirty ? "Submitted - signed off (unsaved edits)" : "Signed off", tone: i.dirty ? "warning" : "success" };
  else if (inReview) rep = { line: "Submitted - awaiting the Estimator", tone: "info" };
  else if (returned) rep = { line: `Returned to the Rep (revision ${i.revision})`, tone: "danger" };
  else if (repPrepDone) rep = { line: "Ready - not yet submitted", tone: "warning" };
  else rep = { line: "Preparation incomplete", tone: "neutral" };

  let est: { line: string; tone: GroupTone };
  if (final) est = { line: "Approved", tone: "success" };
  else if (inReview && i.signoff === "current") {
    // The count and the line must agree: with a current sign-off but cost trouble that only a commercial viewer can see, say so (never to anyone else).
    const costOpen = i.canViewCommercials && all.cost.status === "attention";
    est = i.dirty ? { line: "Signed off - unsaved edits make it stale", tone: "warning" } : costOpen ? { line: "Signed off - cost attention outstanding", tone: "warning" } : { line: "Signed off", tone: "success" };
  }
  else if (inReview && i.signoff === "stale") est = { line: "Sign-off out of date: review again", tone: "warning" };
  else if (inReview) est = { line: youEstimate ? "Awaiting your review" : "Awaiting Estimator review", tone: "info" };
  else if (returned) est = { line: "Returned to the Rep", tone: "danger" };
  else est = { line: "Waiting for the Rep to submit", tone: "neutral" };

  const mkGroup = (id: Stage2GroupId, s: { line: string; tone: GroupTone }): Stage2Group => {
    const own = steps.filter((x) => x.group === id);
    const complete = own.filter((x) => x.status === "complete" || x.counted === true).length;
    return { id, label: STAGE2_GROUP_LABEL[id], statusLine: s.line, tone: s.tone, stepIds: own.map((x) => x.id), complete, total: own.length, attention: own.filter((x) => x.status === "attention").length, progress: `${complete} of ${own.length} complete` };
  };
  const groups = [mkGroup("rep", rep), mkGroup("estimator", est)];

  // ── what is this viewer's to do ──
  const actionable = new Set<Stage2StepId>();
  // Only the group whose turn it is: the Rep's steps while the quote is a Rep draft (nothing for the Rep once submitted, except being returned), the Estimator's once it is in Estimator review.
  for (const s of steps) if (owns(s.group) && !all[s.id].waiting && !final && (s.group === "rep" ? !inReview && i.editable : inReview)) actionable.add(s.id);
  return { steps, groups, actionable };
}

/** The steps "Next incomplete step" may choose from: the viewer's own (and the current one, so the position is known). Never another role's work. */
export function nextCandidates(d: Stage2Derived, currentId: string): Stage2Step[] {
  return d.steps.filter((s) => d.actionable.has(s.id) || s.id === currentId);
}

/**
 * The key an acknowledgement is bound to: the exact version (quote, revision, content hash, last update) and, as belt-and-braces, the live cost and margin. Pure, so every component's
 * effect on it is pinned by a test. It is never rendered or put in an attribute.
 */
export function costAckKey(p: { quoteId: string; revision: number; draftHash: string; updatedAt: string; estimatedCost: number; marginPct: number | null }): string {
  return [p.quoteId, p.revision, p.draftHash, p.updatedAt, p.estimatedCost, p.marginPct].join("|");
}
