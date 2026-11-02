// A claim PREVIEW is a read-only calculation from the project's state at one moment. This key captures the inputs that change what a claim
// would contain (approved completion, what is already committed, claim list). When it differs from the key at preview time, the preview is stale.

import type { ProjectView } from "./project-view";

export function previewKey(view: Pick<ProjectView, "stages" | "claims">): string {
  const stages = view.stages.map((s) => `${s.id}:${s.approvedBps}:${s.committedCents}:${s.valueCents}`).join("|");
  const claims = view.claims.map((c) => `${c.id}:${c.status}:${c.total_cents}`).join("|");
  return `${stages}#${claims}`;
}

export type PreviewState = "NONE" | "CURRENT" | "STALE";
export function previewState(shownKey: string | null, currentKey: string): PreviewState {
  if (shownKey === null) return "NONE";
  return shownKey === currentKey ? "CURRENT" : "STALE";
}
