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
