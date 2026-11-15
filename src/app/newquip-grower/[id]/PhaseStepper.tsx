"use client";

import type { StageId, StageView } from "@/newquip/quote/stages";
import { navPresentation, type NavViewer } from "@/newquip/quote/stage-nav-model";
import { PHASE_STAGES, phaseOfStage, phaseViews } from "@/newquip/quote/phases";

// The phase navigation as ONE compact line (the four phases as small buttons) for the Estimator workspace header. Same data and handlers as StageNav (phases.ts / stage-nav-model.ts): selecting a phase only
// changes what is shown; every action is still authorised on the server. The full StageNav (phase cards, owners, descriptions) stays available in the header's Details.
export function PhaseStepper({ stages, current, viewing, onSelect, previewable = [], viewer }: { stages: StageView[]; current: StageId; viewing: StageId; onSelect: (id: StageId) => void; previewable?: readonly StageId[]; viewer: NavViewer }) {
  const phases = phaseViews(stages);
  const viewPhase = phaseOfStage(viewing);
  const curPhase = phaseOfStage(current);
  return (
    <nav aria-label="Quotation phases" data-testid="phase-stepper">
      <ol className="flex flex-wrap items-center gap-1.5 text-sm">
        {phases.map((p) => {
          const on = p.id === viewPhase;
          const st = stages.find((s) => s.id === p.stageId);
          const pr = st ? navPresentation(st, previewable.includes(p.stageId), viewer) : null;
          return (
            <li key={p.id}>
              <button type="button" aria-current={on ? "step" : undefined} data-phase={p.id} data-stage={p.stageId} onClick={() => { if (!on) onSelect(p.stageId); }}
                className={`inline-flex min-h-11 items-center gap-1.5 rounded-md border px-2.5 text-left ${on ? "border-indigo-600 bg-indigo-50 font-semibold text-slate-900" : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"}`}>
                <span className="text-xs text-slate-600">{p.id}</span><span>{p.label}</span>{p.id === curPhase && <span className="text-xs text-slate-600">· you are here</span>}{pr && !on ? <span className="text-xs text-slate-600">· {pr.chip}</span> : null}
              </button>
            </li>
          );
        })}
      </ol>
      {viewPhase === 4 && <span className="sr-only">{PHASE_STAGES[4].length} customer and handover steps</span>}
    </nav>
  );
}
