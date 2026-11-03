import type { StageView } from "./stages";

// Stage navigation labels (pure). "Preview only" replaces "Not yet available" ONLY for a stage the page can genuinely show read-only while it is unavailable (today: Stage 4's
// customer summary once the quote is READY). The page decides `previewable` from what it already renders; this never gates a stage and never makes it operational.

export function navStatusLabel(stage: StageView, previewable: boolean, viewer?: { roles: readonly string[]; state: string }): string {
  if (stage.status === "NOT_AVAILABLE" && previewable) return "Preview only";
  // Stage 2 "Awaiting action" while the quote is with the Estimator is not viewer-relative (computeStages is not). For a viewer who is only a Rep nothing is left to do there, so the chip says where
  // the quote is; an Estimator who is not a Manager is told it is theirs. Presentation only: the stage status, its "Next:" line and every gate are unchanged.
  if (viewer && stage.id === 2 && stage.status === "AWAITING_ACTION" && viewer.state === "ESTIMATOR_REVIEW") {
    const has = (r: string) => viewer.roles.includes(r);
    if (has("rep") && !has("estimator") && !has("manager")) return "With the Estimator";
    if (has("estimator") && !has("manager")) return "Awaiting your review";
  }
  // Stage 1 is COMPLETE once the quote is READY, but a Rep still has to submit it: for a Rep on a Rep draft the chip says so (never "Complete" before the submission). Nobody else sees this wording.
  if (viewer && stage.id === 1 && stage.status === "COMPLETE" && viewer.state === "REP_DRAFT" && viewer.roles.includes("rep")) return "Ready to submit";
  return stage.statusLabel;
}

export interface NavViewer { roles: readonly string[]; state: string; /** Open items only an Estimator can resolve (mapping / manual prices): lets an Estimator-only viewer see why Stage 2 is theirs on a Rep draft. */ estimatorOpen?: number; /** The Estimator's sign-off on the current content exists (the next owner is then the Manager). */ signedOff?: boolean }
export interface NavPresentation { chip: string; summary: string; next: string | null }

/**
 * VIEWER-RELATIVE wording of a stage chip and its next-action line. computeStages is not viewer-relative and is NOT changed: it names the role that has to act, which reads wrongly to someone who is not
 * that role (an Estimator told "Rep: submit...", a Rep or an observer told "Create the Project" on a task they cannot do). Only presentation changes; every gate stays on the server.
 */
export function navPresentation(stage: StageView, previewable: boolean, viewer?: NavViewer): NavPresentation {
  const base: NavPresentation = { chip: navStatusLabel(stage, previewable, viewer), summary: stage.summary, next: stage.next };
  if (!viewer) return base;
  const has = (r: string) => viewer.roles.includes(r);
  const noRole = !has("rep") && !has("estimator") && !has("manager");
  // Stage 2 for an Estimator who is not also the Rep, on a Rep draft: the Rep cannot submit until the Estimator's own items are done (or has not finished); say whose turn it is, consistently.
  if (stage.id === 2 && viewer.state === "REP_DRAFT" && has("estimator") && !has("rep") && !has("manager") && stage.status !== "RETURNED") {
    if ((viewer.estimatorOpen ?? 0) > 0) return { chip: "Your mapping is needed", summary: "Mapping and manual prices are outstanding.", next: "Estimator: map the products and enter the manual prices listed in Stage 2, step 1." };
    if (stage.status === "AWAITING_ACTION") return { chip: "With the Rep", summary: "Nothing is left for you until the Rep submits.", next: "Rep: submit the quotation to the Estimator (Stage 1, step 5)." };
  }
  // Stage 1 once the Rep has submitted: "Complete" alone read as if nothing followed (the banner says Stage 2). Name what is next.
  if (stage.id === 1 && stage.status === "COMPLETE" && viewer.state === "ESTIMATOR_REVIEW") return { ...base, chip: viewer.signedOff ? "Rep preparation complete - next: Stage 3 (Manager)" : "Rep preparation complete - next: Stage 2 (Estimator)" };
  // Stage 6: creating the Project is the Manager's action. Anyone else sees whose turn it is.
  if (stage.id === 6 && stage.status === "AWAITING_ACTION" && !has("manager")) return { chip: noRole ? "Read-only: you have no quote role" : "Waiting on the Manager", summary: "Eligible: the Manager creates the Project from the accepted baseline.", next: "Manager: create the Project." };
  if (stage.status === "AWAITING_ACTION" && noRole) return { ...base, chip: "Read-only: you have no quote role" };
  return base;
}
