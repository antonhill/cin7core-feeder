// Pure model for the StepRail (no React, no server actions, no stores). A step is NAVIGATION and GUIDANCE only: its status is derived from data by the caller and never from
// the step having been visited, and nothing here blocks moving to another step.

export type StepStatus = "complete" | "attention" | "incomplete" | "unavailable" | "review";
export interface RailStep { id: string; label: string; status: StepStatus; /** Optional: counts toward the "complete" totals (and is skipped by "next incomplete") although its status label is not Complete, e.g. a Review step that has since been reviewed. Draws no check glyph. */ counted?: boolean; /** Optional visible status text replacing the default label of `status` (e.g. "Reviewed" for a counted Review step). */ statusLabel?: string; /** Optional one-line explanation shown beside the status. */ note?: string; /** Optional id of the RailGroup this step belongs to (only used when the rail is given `groups`). */ group?: string }

export type RailGroupTone = "complete" | "attention" | "incomplete" | "neutral";
/** A labelled block of steps with its own owner, count and one caller-supplied status line. The counts are computed ONLY over the group's own steps. */
export interface RailGroup {
  id: string; label: string;
  /** The responsible role, e.g. "Rep", shown as a tag. */
  owner?: string;
  /** One short, truthful status line for the group, supplied by the caller (e.g. "Submitted - awaiting the Estimator"). */
  statusText?: string;
  tone?: RailGroupTone;
}

export const STEP_STATUS_LABEL: Record<StepStatus, string> = { complete: "Complete", attention: "Needs attention", incomplete: "Not complete", unavailable: "Not available", review: "Review needed" };

export const completeCount = (steps: readonly RailStep[]): number => steps.filter((s) => s.status === "complete" || s.counted === true).length;

/**
 * The step "Next incomplete step" jumps to: the first step AFTER the current one that is not complete (a step that is not available to this viewer is skipped); when nothing
 * follows, the first earlier one. null when every step is complete (or only the current one is left).
 */
export function nextIncompleteStepId(steps: readonly RailStep[], currentId: string, include?: (step: RailStep) => boolean): string | null {
  // `include` lets a caller leave out steps that are not the viewer's responsibility (e.g. another role's group); without it every step counts, as before.
  const open = (s: RailStep) => s.status !== "complete" && s.counted !== true && s.status !== "unavailable" && s.id !== currentId && (include ? include(s) : true);
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

/** "n of m complete" per group, over that group's own steps only. Steps whose `group` matches no group are not counted anywhere. */
export function groupCounts(steps: readonly RailStep[], groups: readonly RailGroup[]): Array<{ id: string; label: string; done: number; total: number }> {
  return groups.map((g) => { const own = steps.filter((s) => s.group === g.id); return { id: g.id, label: g.label, done: completeCount(own), total: own.length }; });
}
