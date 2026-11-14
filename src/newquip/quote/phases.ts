import type { StageId, StageStatus, StageView } from "./stages";

// FOUR USER-FACING PHASES (pure presentation). The six workflow stages (stages.ts) are unchanged: this only groups them for the progress bar a person sees.
//
//   1 Configure & Submit (Rep) | 2 Cost & Verify (Estimator) | 3 Approve or Return (Manager) | 4 Customer & Handover (Rep and Manager) = stages 4 + 5 + 6
//
// A phase has no stored state and authorises nothing. Its status is the status of ONE representative stage of the phase (for phase 4: the first of stages 4-6 that is not yet done, else the last), so
// the wording stays exactly what computeStages / navPresentation already say. Every action is still authorised on the server.

export type PhaseId = 1 | 2 | 3 | 4;
export const PHASE_IDS: readonly PhaseId[] = [1, 2, 3, 4];
export const PHASE_LABEL: Record<PhaseId, string> = { 1: "Configure & Submit", 2: "Cost & Verify", 3: "Approve or Return", 4: "Customer & Handover" };
export const PHASE_OWNER: Record<PhaseId, string> = { 1: "Rep", 2: "Estimator", 3: "Manager", 4: "Rep and Manager" };
export const PHASE_STAGES: Record<PhaseId, readonly StageId[]> = { 1: [1], 2: [2], 3: [3], 4: [4, 5, 6] };

export const phaseOfStage = (s: StageId): PhaseId => (s <= 3 ? (s as PhaseId) : 4);

const DONE: ReadonlySet<StageStatus> = new Set<StageStatus>(["COMPLETE", "NOT_REQUIRED"]);

/** The stage that stands for the phase: the first stage of the phase that is not yet done (a stage that is LOADING or not yet available counts as not done), else the last stage of the phase. */
export function representativeStage(phase: PhaseId, stages: readonly StageView[]): StageId {
  const ids = PHASE_STAGES[phase];
  const views = ids.map((id) => stages.find((s) => s.id === id)).filter((s): s is StageView => !!s);
  const open = views.find((s) => !DONE.has(s.status));
  return (open ?? views[views.length - 1])?.id ?? ids[0];
}

export interface PhaseView { id: PhaseId; label: string; owner: string; stageIds: readonly StageId[]; /** The stage whose status, wording and "Next:" line this phase shows, and where selecting the phase opens. */ stageId: StageId }

export function phaseViews(stages: readonly StageView[]): PhaseView[] {
  return PHASE_IDS.map((id) => ({ id, label: PHASE_LABEL[id], owner: PHASE_OWNER[id], stageIds: PHASE_STAGES[id], stageId: representativeStage(id, stages) }));
}
