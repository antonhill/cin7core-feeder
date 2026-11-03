import type { RailStep, StepStatus } from "@/components/ui/step-rail-model";

// SOLUTION BUILDER STAGE 2 STEPS (pure). Four steps over the panels that already exist; a step is complete ONLY from data the page has already loaded (the readiness result,
// the budget, the draft's own validation and the quotation's stage gates) and never because it was visited. Nothing here gates navigation or authorises anything: the action
// buttons keep their own disabled reasons.
//
//   1 Lines & mappings   2 Charges, exclusions & prices   3 Cost & margin (only for a viewer who may see commercials)   4 Handoff

export type Stage2StepId = "lines" | "charges" | "cost" | "handoff";
export const STAGE2_STEP_LABEL: Record<Stage2StepId, string> = { lines: "Lines & mappings", charges: "Charges, exclusions & prices", cost: "Cost & margin", handoff: "Handoff" };

/** The steps this viewer has. A viewer who may not see commercials has three: the Cost & margin step does not exist for them (not hidden, absent). */
export const stage2StepIds = (canViewCommercials: boolean): Stage2StepId[] => (canViewCommercials ? ["lines", "charges", "cost", "handoff"] : ["lines", "charges", "handoff"]);

type QuoteStateName = "REP_DRAFT" | "ESTIMATOR_REVIEW" | "MANAGER_APPROVED_FINAL";
type BridgeStatus = string;

export interface Stage2Input {
  canViewCommercials: boolean;
  state: QuoteStateName;
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
}

type Result = { status: StepStatus; note?: string };
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function deriveStage2Steps(i: Stage2Input): Array<RailStep & { id: Stage2StepId }> {
  const finishStage1 = (): Result => ({ status: "incomplete", note: "Finish the Stage 1 configuration first" });
  const live = i.lines.filter((l) => l.basis !== "not_selected");

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

  let cost: Result;
  if (!i.canViewCommercials) cost = { status: "unavailable" };
  else if (!i.calcValid || i.budget == null) cost = { status: "incomplete", note: "Cost figures are not available yet" };
  else if (i.incompleteCostOverrideCount > 0) cost = { status: "attention", note: plural(i.incompleteCostOverrideCount, "cost override is incomplete", "cost overrides are incomplete") };
  else if (i.budget.incomplete) cost = { status: "attention", note: "The estimate is partial until every blocker is resolved" };
  else if (i.budget.marginPct == null) cost = { status: "attention", note: "The margin is not available" };
  else cost = { status: "complete", ...(i.state === "MANAGER_APPROVED_FINAL" ? {} : { note: "Workbook basis. Cin7 cost capture is checked in its own panel" }) };

  let handoff: Result;
  if (i.state === "MANAGER_APPROVED_FINAL") handoff = { status: "complete", note: "Approved" };
  else if (i.state === "ESTIMATOR_REVIEW") {
    if (i.signoff === "current") handoff = { status: "complete", note: "Estimator sign-off is current" };
    else if (i.signoff === "stale") handoff = { status: "attention", note: "The sign-off no longer matches the quotation" };
    else if (i.readiness.state !== "READY") handoff = { status: "attention", note: "The quote must be READY before it can be signed off" };
    else handoff = { status: "incomplete", note: "Awaiting the Estimator's sign-off" };
  } else if (i.readiness.state !== "READY") handoff = { status: "attention", note: "The quote must be READY before the price can be confirmed" };
  else if (!i.totalAvailable) handoff = { status: "attention", note: "The quote total is not available yet" };
  else handoff = { status: "incomplete", note: i.confirmedRecorded ? "Confirmation recorded; not yet sent" : "Ready for the price confirmation" };

  const all: Record<Stage2StepId, Result> = { lines, charges, cost, handoff };
  return stage2StepIds(i.canViewCommercials).map((id) => ({ id, label: STAGE2_STEP_LABEL[id], status: all[id].status, ...(all[id].note ? { note: all[id].note } : {}) }));
}
