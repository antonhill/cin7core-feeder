import type { StageView } from "./stages";

// Stage navigation labels (pure). "Preview only" replaces "Not yet available" ONLY for a stage the page can genuinely show read-only while it is unavailable (today: Stage 4's
// customer summary once the quote is READY). The page decides `previewable` from what it already renders; this never gates a stage and never makes it operational.

export function navStatusLabel(stage: StageView, previewable: boolean): string {
  return stage.status === "NOT_AVAILABLE" && previewable ? "Preview only" : stage.statusLabel;
}
