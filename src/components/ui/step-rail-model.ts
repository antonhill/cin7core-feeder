// Pure model for the StepRail (no React, no server actions, no stores). A step is NAVIGATION and GUIDANCE only: its status is derived from data by the caller and never from
// the step having been visited, and nothing here blocks moving to another step.

export type StepStatus = "complete" | "attention" | "incomplete" | "unavailable" | "review";
export interface RailStep { id: string; label: string; status: StepStatus; /** Optional one-line explanation shown beside the status. */ note?: string; /** An optional step: while not complete it reads "Optional" rather than "Not complete". Presentation only. */ optional?: boolean }

export const STEP_STATUS_LABEL: Record<StepStatus, string> = { complete: "Complete", attention: "Needs attention", incomplete: "Not complete", unavailable: "Not available", review: "Review" };

export const completeCount = (steps: readonly RailStep[]): number => steps.filter((s) => s.status === "complete").length;

/**
 * The step "Next incomplete step" jumps to: the first step AFTER the current one that is not complete (a step that is not available to this viewer is skipped); when nothing
 * follows, the first earlier one. null when every step is complete (or only the current one is left).
 */
export function nextIncompleteStepId(steps: readonly RailStep[], currentId: string): string | null {
  const open = (s: RailStep) => s.status !== "complete" && s.status !== "unavailable" && s.id !== currentId;
  const at = steps.findIndex((s) => s.id === currentId);
  return steps.slice(at + 1).find(open)?.id ?? steps.slice(0, Math.max(at, 0)).find(open)?.id ?? null;
}

/** Reads a 1-based `?step=` value: anything that is not a whole number from 1 to `count` falls back to 1. */
export function parseStepParam(raw: string | null | undefined, count: number): number {
  if (raw == null || !/^\d+$/.test(raw.trim())) return 1;
  const n = Number(raw);
  return n >= 1 && n <= count ? n : 1;
}

export const stepHeadingId = (railId: string, stepId: string) => `${railId}-${stepId}-heading`;
