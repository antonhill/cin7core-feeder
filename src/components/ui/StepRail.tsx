"use client";

import { useEffect, useRef, useState } from "react";
import { STEP_STATUS_LABEL, completeCount, groupCounts, stepHeadingId, type RailGroup, type RailGroupTone, type RailStep, type StepStatus } from "./step-rail-model";

// The step rail: an ordered list with one button per step (a number, or a check once the step is complete from DATA), its label and its status as TEXT. Presentation only.
// From 701px the cards sit in a grid of equal columns that wraps to more rows instead of scrolling or clipping; at 700px and below it collapses to a disclosure "Step n of N · name · k complete" that lists the steps.
// Cards in a row are EQUAL height (the row grows to the tallest card; no text is ever clamped): icon top-left at a fixed size, the title at the same top offset, the note
// under it and the status pinned to the bottom of the card. With `groups` each group is a labelled block with its own count and status line.

const TEXT_TONE: Record<StepStatus, string> = { complete: "text-emerald-800", attention: "text-amber-900", incomplete: "text-slate-700", review: "text-slate-800", unavailable: "text-slate-600" };
const BADGE_TONE: Record<StepStatus, string> = {
  complete: "border-emerald-700 bg-emerald-700 text-white", attention: "border-amber-600 bg-amber-50 text-amber-900", incomplete: "border-slate-400 bg-white text-slate-700", review: "border-indigo-500 bg-indigo-50 text-indigo-900", unavailable: "border-slate-300 bg-slate-50 text-slate-600",
};
const GROUP_TONE: Record<RailGroupTone, string> = { complete: "bg-emerald-50 text-emerald-800", attention: "bg-amber-50 text-amber-900", incomplete: "bg-slate-100 text-slate-700", neutral: "bg-slate-100 text-slate-700" };
const GROUP_MARK: Record<RailGroupTone, string> = { complete: "✓", attention: "!", incomplete: "•", neutral: "•" };

function Card({ step, number, current, onPick, tall }: { step: RailStep; number: number; current: boolean; onPick: () => void; tall: boolean }) {
  // Cards may shrink (min-w-0) so nothing clips: the rail is a wrapping grid of equal columns from 701px (equal height within a row); `tall` = a card inside a group, a flex item from 901px.
  return (
    <li className={`flex ${tall ? "min-w-0 min-[901px]:flex-1" : "min-w-0"}`}>
      <button type="button" onClick={onPick} aria-current={current ? "step" : undefined} data-step={step.id}
        className={`flex min-h-11 w-full items-start gap-3 rounded-lg border p-3 text-left transition-colors ${tall ? "min-[701px]:min-h-28" : ""} ${current ? "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-600" : "border-slate-200 bg-white hover:bg-slate-50"}`}>
        <span aria-hidden className={`flex size-7 shrink-0 items-center justify-center rounded-full border text-sm font-bold ${BADGE_TONE[step.status]}`}>{step.status === "complete" ? "✓" : number}</span>
        <span className="flex min-h-full min-w-0 flex-1 flex-col self-stretch">
          <span className="pt-1 text-sm font-semibold leading-5 text-slate-900">{step.label}</span>
          {step.note && <span className="mt-0.5 text-xs text-slate-700">{step.note}</span>}
          <span className={`mt-auto pt-1 text-xs font-semibold ${TEXT_TONE[step.status]}`} data-testid={`step-status-${step.id}`}>{step.statusLabel ?? STEP_STATUS_LABEL[step.status]}</span>
        </span>
      </button>
    </li>
  );
}

export function StepRail({ id, steps, currentId, onSelect, ariaLabel, actions, groups }: {
  id: string; steps: RailStep[]; currentId: string; onSelect: (stepId: string) => void; ariaLabel: string; actions?: React.ReactNode;
  /** Optional: render the steps as labelled blocks (a step's `group` names its block). Without it the rail is one list, exactly as before. */
  groups?: RailGroup[];
}) {
  const [open, setOpen] = useState(false);
  const at = Math.max(0, steps.findIndex((s) => s.id === currentId));
  const cur = steps[at];
  const done = completeCount(steps);
  const attention = steps.filter((s) => s.status === "attention").length;
  const counts = groups ? groupCounts(steps, groups) : null;
  const summary = counts
    ? `Step ${at + 1} of ${steps.length} · ${cur?.label ?? ""} · ${counts.map((c) => `${c.label} ${c.done} of ${c.total} complete`).join(" · ")}${attention > 0 ? ` · ${attention} need attention` : ""}`
    : `Step ${at + 1} of ${steps.length} · ${cur?.label ?? ""} · ${done} complete${attention > 0 ? ` · ${attention} need attention` : ""}`;
  const pick = (stepId: string) => () => { onSelect(stepId); setOpen(false); };
  // Inside a group: one column below 701px, a wrapping grid of equal-height rows at 701-900px (groups stack full width), one equal-height row of shrinkable cards from 901px.
  const groupListCls = "flex flex-col gap-2 min-[701px]:grid min-[701px]:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))] min-[901px]:flex min-[901px]:flex-row";
  const numberOf = (s: RailStep) => steps.indexOf(s) + 1;
  const ungrouped = groups ? steps.filter((s) => !groups.some((g) => g.id === s.group)) : [];
  // From 901px the groups are columns of ONE grid with two shared rows (header, cards) via subgrid, so headers align and every card is the same height across groups; from 701 to 900px the groups stack full width. `hidden` applies only below 701px (max-[700px]), so it can never beat a layout class above it.
  return (
    <nav aria-label={ariaLabel} className="mt-4" data-testid="step-rail">
      <button type="button" aria-expanded={open} aria-controls={`${id}-list`} onClick={() => setOpen((o) => !o)} data-testid="step-rail-toggle"
        className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm font-semibold text-slate-900 min-[701px]:hidden">
        <span>{summary}</span><span aria-hidden>{open ? "▲" : "▼"}</span>
      </button>
      {!groups ? (
        <ol id={`${id}-list`} className={`${open ? "" : "max-[700px]:hidden"} mt-2 flex flex-col gap-2 min-[701px]:mt-0 min-[701px]:grid min-[701px]:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]`}>
          {steps.map((s, i) => <Card key={s.id} step={s} number={i + 1} current={s.id === currentId} onPick={pick(s.id)} tall={false} />)}
        </ol>
      ) : (
        <div id={`${id}-list`} style={{ gridTemplateColumns: [...groups.map((g) => `minmax(0,${Math.max(steps.filter((s) => s.group === g.id).length, 1)}fr)`), ...(ungrouped.length ? [`minmax(0,${ungrouped.length}fr)`] : [])].join(" ") }}
          className={`${open ? "" : "max-[700px]:hidden"} mt-2 flex flex-col gap-3 min-[701px]:mt-0 min-[901px]:grid min-[901px]:grid-rows-[auto_1fr] min-[901px]:gap-x-3 min-[901px]:gap-y-2`}>
          {groups.map((g, gi) => {
            const own = steps.filter((s) => s.group === g.id);
            const c = counts![gi];
            const tone = g.tone ?? "neutral";
            return (
              <div key={g.id} role="group" aria-labelledby={`${id}-${g.id}-label`} data-testid={`step-group-${g.id}`} className="flex min-w-0 flex-col gap-2 min-[901px]:row-span-2 min-[901px]:grid min-[901px]:grid-rows-subgrid">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span id={`${id}-${g.id}-label`} className="text-xs font-bold uppercase tracking-wide text-slate-800">{g.label}</span>
                  {g.owner && <span className="rounded-md border border-slate-300 bg-white px-1.5 py-0.5 text-xs font-semibold text-slate-700" data-testid={`step-group-owner-${g.id}`}>{g.owner}</span>}
                  <span className="text-xs font-semibold text-slate-700" data-testid={`step-group-count-${g.id}`}>{c.done} of {c.total} complete</span>
                  {g.statusText && <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-semibold ${GROUP_TONE[tone]}`} data-tone={tone} data-testid={`step-group-status-${g.id}`}><span aria-hidden>{GROUP_MARK[tone]}</span>{g.statusText}</span>}
                </div>
                <ol aria-labelledby={`${id}-${g.id}-label`} className={groupListCls}>
                  {own.map((s) => <Card key={s.id} step={s} number={numberOf(s)} current={s.id === currentId} onPick={pick(s.id)} tall />)}
                </ol>
              </div>
            );
          })}
          {ungrouped.length > 0 && <ol className={`${groupListCls} min-[901px]:row-span-2`}>{ungrouped.map((s) => <Card key={s.id} step={s} number={numberOf(s)} current={s.id === currentId} onPick={pick(s.id)} tall />)}</ol>}
        </div>
      )}
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
