"use client";

import { useEffect, useRef, useState } from "react";
import { STEP_STATUS_LABEL, completeCount, stepHeadingId, type RailStep, type StepStatus } from "./step-rail-model";

// The step rail: an ordered list with one button per step (a number, or a check once the step is complete from DATA), its label and its status as TEXT. Presentation only.
// Wide screens show one row (it scrolls sideways on a tablet); at 700px and below it collapses to a disclosure "Step n of N · name · k complete" that lists the steps.

const TEXT_TONE: Record<StepStatus, string> = { complete: "text-emerald-800", attention: "text-amber-900", incomplete: "text-slate-700", unavailable: "text-slate-600" };
const BADGE_TONE: Record<StepStatus, string> = {
  complete: "border-emerald-700 bg-emerald-700 text-white", attention: "border-amber-600 bg-amber-50 text-amber-900", incomplete: "border-slate-400 bg-white text-slate-700", unavailable: "border-slate-300 bg-slate-50 text-slate-600",
};

export function StepRail({ id, steps, currentId, onSelect, ariaLabel, actions }: {
  id: string; steps: RailStep[]; currentId: string; onSelect: (stepId: string) => void; ariaLabel: string; actions?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const at = Math.max(0, steps.findIndex((s) => s.id === currentId));
  const cur = steps[at];
  const done = completeCount(steps);
  const summary = `Step ${at + 1} of ${steps.length} · ${cur?.label ?? ""} · ${done} complete`;
  return (
    <nav aria-label={ariaLabel} className="mt-4" data-testid="step-rail">
      <button type="button" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen((o) => !o)} data-testid="step-rail-toggle"
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm font-semibold text-slate-900 min-[701px]:hidden">
        <span>{summary}</span><span aria-hidden>{open ? "▲" : "▼"}</span>
      </button>
      <ol id={`${id}-list`} className={`${open ? "flex" : "hidden"} mt-2 flex-col gap-2 min-[701px]:mt-0 min-[701px]:flex min-[701px]:flex-row min-[701px]:overflow-x-auto min-[701px]:pb-1`}>
        {steps.map((s, i) => {
          const on = s.id === currentId;
          return (
            <li key={s.id} className="min-[701px]:min-w-44 min-[701px]:flex-1">
              <button type="button" onClick={() => { onSelect(s.id); setOpen(false); }} aria-current={on ? "step" : undefined} data-step={s.id}
                className={`flex min-h-11 w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${on ? "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-600" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
                <span aria-hidden className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-bold ${BADGE_TONE[s.status]}`}>{s.status === "complete" ? "✓" : i + 1}</span>
                <span className="flex min-w-0 flex-col">
                  <span className="text-sm font-semibold text-slate-900">{s.label}</span>
                  <span className={`text-xs font-semibold ${TEXT_TONE[s.status]}`} data-testid={`step-status-${s.id}`}>{s.optional && s.status === "incomplete" ? "Optional" : STEP_STATUS_LABEL[s.status]}</span>
                  {s.note && <span className="text-xs text-slate-700">{s.note}</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      {/* No live region: the current step is announced by aria-current and by the focus move to its heading. */}
      {actions}
    </nav>
  );
}

/**
 * One step's content. A step that is not shown stays MOUNTED (so its requests and state are untouched) but is `hidden` and `inert`; with "show all" every step is shown.
 * When this step becomes the current one its heading takes focus.
 */
export function StepPanel({ railId, stepId, number, title, current, showAll, className = "", headingClassName = "col-span-full", children }: {
  railId: string; stepId: string; number: number; title: string; current: boolean; showAll: boolean; className?: string; /** Layout classes of the heading (default: a full-width row of a grid parent). */ headingClassName?: string; children: React.ReactNode;
}) {
  const hidden = !current && !showAll;
  const heading = useRef<HTMLHeadingElement>(null);
  const was = useRef(current);
  useEffect(() => {
    if (current && !was.current) heading.current?.focus();
    was.current = current;
  }, [current]);
  return (
    <section hidden={hidden} inert={hidden} aria-labelledby={stepHeadingId(railId, stepId)} data-step-panel={stepId} className={className}>
      <h2 id={stepHeadingId(railId, stepId)} ref={heading} tabIndex={-1} className={`${headingClassName} text-lg font-semibold text-slate-900 outline-none focus-visible:ring-2 focus-visible:ring-indigo-600`}>Step {number} · {title}</h2>
      {children}
    </section>
  );
}
