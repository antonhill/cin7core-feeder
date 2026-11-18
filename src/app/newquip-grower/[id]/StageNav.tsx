"use client";

import { useRef, useState } from "react";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import type { StageId, StageStatus, StageView } from "@/newquip/quote/stages";
import { navPresentation, type NavViewer } from "@/newquip/quote/stage-nav-model";
import { PHASE_STAGES, phaseOfStage, phaseViews } from "@/newquip/quote/phases";

// The Solution Builder's progress bar: FOUR user-facing phases (phases.ts) over the six workflow stages. Pure presentation of computeStages(): the status of every stage is derived from the quotation's
// existing state and immutable records, a phase shows the status of its representative stage, and selecting a phase only changes what is shown - every action is still authorised on the server.
// Customer & Handover groups stages 4, 5 and 6; while it is viewed, a small step list (data-stage 4/5/6) keeps each of them reachable.
const TONE: Record<StageStatus, BadgeTone> = { LOADING: "neutral", COMPLETE: "success", IN_PROGRESS: "info", AWAITING_ACTION: "warning", RETURNED: "danger", NOT_STARTED: "neutral", NOT_AVAILABLE: "neutral", NOT_REQUIRED: "neutral" };

// At 700px and below the four phases collapse to a disclosure "Phase n of 4 · name" that lists all four with their status (every phase stays reachable).
export function StageNav({ stages, current, viewing, onSelect, previewable = [], viewer, compact = false, hideNext = false }: {
  /** Hide the one-line next-action row (the page shows the same fact in its own bar, e.g. Stage 2's owner line). */ hideNext?: boolean;
  /** Inside a step-based stage the phase cards collapse to the one-line indicator at every width (expandable); the list stays in the DOM. */ compact?: boolean; stages: StageView[]; current: StageId; viewing: StageId; onSelect: (id: StageId) => void; /** Unavailable stages the page can show read-only (labelled "Preview only"). */ previewable?: readonly StageId[]; /** The viewer's roles and the quote state, for viewer-relative wording of the status chip only. */ viewer?: NavViewer }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  // Closing the list hides the focused button (display:none), which would drop focus to <body>: move it to the toggle instead (only when the list was open).
  const close = () => { if (open) { setOpen(false); toggle.current?.focus(); } };
  const phases = phaseViews(stages);
  const stageOf = (id: StageId) => stages.find((s) => s.id === id);
  const pres = (id: StageId) => { const s = stageOf(id); return s ? navPresentation(s, previewable.includes(id), viewer) : null; };
  const viewPhase = phaseOfStage(viewing);
  const curPhase = phases.find((p) => p.id === phaseOfStage(current));
  const viewP = phases.find((p) => p.id === viewPhase);
  const viewChip = viewP ? pres(viewP.id === 4 && PHASE_STAGES[4].includes(viewing) ? viewing : viewP.stageId)?.chip : null;
  const curPres = pres(current);
  return (
    <div className={compact ? "mt-2 rounded-lg border border-slate-300 bg-white" : "mt-6 space-y-3"} data-testid="stage-nav">
      <nav aria-label="Quotation phases" onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}>
        <button ref={toggle} type="button" aria-expanded={open} aria-controls="stage-nav-list" onClick={() => setOpen((o) => !o)} data-testid="stage-nav-toggle"
          className={`flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm font-semibold text-slate-900 ${compact ? "border-0! rounded-b-none" : "min-[701px]:hidden"}`}>
          <span>Phase {viewPhase} of {phases.length} · {viewP?.label ?? ""}{compact && viewChip ? <span className="font-normal text-slate-700"> · {viewChip}</span> : null}</span><span className="text-xs font-normal text-slate-700"><span className="max-sm:sr-only">{compact ? (open ? "Hide all phases " : "Show all phases ") : ""}</span><span aria-hidden>{open ? "▲" : "▼"}</span></span>
        </button>
        <ol id="stage-nav-list" className={`${open ? "grid" : "hidden"} mt-2 grid-cols-1 gap-2 ${compact ? "" : "min-[701px]:mt-0 min-[701px]:grid"} sm:grid-cols-2 lg:grid-cols-4`}>
          {phases.map((p) => {
            const on = p.id === viewPhase;
            const here = p.id === curPhase?.id;
            const rep = stageOf(p.stageId);
            const pr = pres(p.stageId);
            return (
              <li key={p.id}>
                <button type="button" onClick={() => { if (!on) onSelect(p.stageId); close(); }} aria-current={on ? (p.id === 4 ? "true" : "step") : undefined} data-phase={p.id} data-stage={p.stageId}
                  className={`flex h-full min-h-11 w-full flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${on ? "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-600" : "border-slate-200 bg-white hover:bg-slate-50"}${rep?.status === "NOT_AVAILABLE" && !on ? " border-dashed bg-slate-50" : ""}`}>
                  {/* Every card has the same three zones: a header of fixed height (the owner, and "you are here"), the title (grows, never truncated) and the status chip pinned to the bottom. */}
                  <span className="block w-full lg:min-h-8 text-xs font-semibold text-slate-600">{p.owner}{here ? " · you are here" : ""}</span>
                  <span className="text-sm font-semibold text-slate-900">{p.label}</span>
                  <span className="mt-auto pt-1">{rep && pr ? <Status tone={TONE[rep.status]}>{pr.chip}</Status> : null}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {viewPhase === 4 && (
          <ol className="mt-2 flex flex-wrap gap-2" aria-label="Customer & Handover steps" data-testid="phase4-steps">
            {PHASE_STAGES[4].map((id) => {
              const s = stageOf(id);
              const pr = pres(id);
              if (!s || !pr) return null;
              const on = id === viewing;
              return (
                <li key={id}>
                  <button type="button" onClick={() => { if (!on) onSelect(id); close(); }} aria-current={on ? "step" : undefined} data-stage={id}
                    className={`inline-flex min-h-11 items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm ${on ? "border-indigo-600 bg-indigo-50 font-semibold text-slate-900 ring-2 ring-indigo-600" : "border-slate-200 bg-white text-slate-800 hover:bg-slate-50"}`}>
                    <span>{s.label}</span><Status tone={TONE[s.status]}>{pr.chip}</Status>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </nav>
      {curPhase && curPres && !hideNext && (
        <p className={compact ? "border-t border-slate-100 px-3 py-1 text-xs text-slate-700 max-sm:hidden" : "rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700"} data-testid="next-action">
          <span className="font-semibold text-slate-900">{curPhase.label}:</span> {curPres.summary}{curPres.next ? <> <span className="font-semibold text-indigo-700">Next: {curPres.next}</span></> : null}
        </p>
      )}
    </div>
  );
}
