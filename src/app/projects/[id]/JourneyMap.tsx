"use client";

// Project Journey (UX-006d). PRESENTATION ONLY: every status comes from buildJourney (pure, unit-tested) over state the Overview already holds. This module imports no server
// action and no store, so it can never add a request; its links use the Overview's own onOpenTab. A station says its status in words beside a mark, never by colour alone, and an
// unloaded value says "Not read yet" rather than a status or a zero. On a phone each lane is a one-line summary until it is opened.
import { useState } from "react";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import { JOURNEY_STATUS_LABEL, JOURNEY_UNKNOWN_LABEL, type Journey, type JourneyLane, type JourneyStation, type JourneyStatus, type OverviewTab } from "@/lib/projects/overview-model";

const TONE: Record<JourneyStatus, BadgeTone> = { not_started: "neutral", in_progress: "info", completed: "success", needs_attention: "warning", blocked: "danger" };
const KEY: JourneyStatus[] = ["not_started", "in_progress", "completed", "needs_attention", "blocked"];

function StationRow({ s, onOpenTab }: { s: JourneyStation; onOpenTab: (tab: OverviewTab) => void }) {
  return (
    <li className="space-y-1.5 py-3" data-testid={`journey-${s.id}`} data-status={s.unknown ? "unknown" : s.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-slate-900">{s.label}</span>
        <Status tone={s.unknown ? "neutral" : s.soft ? "warning" : TONE[s.status]}>{s.unknown ? s.statusLabel ?? JOURNEY_UNKNOWN_LABEL : s.statusLabel ?? JOURNEY_STATUS_LABEL[s.status]}</Status>
        {s.informational && <span className="text-xs italic text-slate-600">(informational)</span>}
      </div>
      <p className="text-xs leading-snug text-slate-700">{s.detail}</p>
      {s.lines?.map((l) => <p key={l} className="text-xs leading-snug text-slate-700">{l}</p>)}
      {s.needs.map((n) => <p key={n} className="text-xs font-medium leading-snug text-slate-800">{n}</p>)}
      {s.link && (
        <button type="button" aria-label={`${s.link.label}: ${s.label}`} className="inline-flex min-h-11 min-w-11 items-center rounded-md px-1 text-xs font-medium text-indigo-700 underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700" onClick={() => onOpenTab(s.link!.tab)}>
          {s.link.label}
        </button>
      )}
    </li>
  );
}

function summaryText(l: JourneyLane): string {
  const parts = [
    l.summary.attention > 0 ? `${l.summary.attention} need${l.summary.attention === 1 ? "s" : ""} attention` : "",
    l.summary.inProgress > 0 ? `${l.summary.inProgress} in progress` : "",
    l.summary.unknown > 0 ? `${l.summary.unknown} not read yet` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : l.stations.length === 0 ? "Nothing to show" : "Nothing needs attention";
}

function Lane({ lane, open, onToggle, onOpenTab, id }: { lane: JourneyLane; open: boolean; onToggle: () => void; onOpenTab: (tab: OverviewTab) => void; id: string }) {
  const bodyId = `${id}-body`;
  return (
    <div className="min-w-0 rounded-xl border border-slate-200 bg-white px-4 py-3" data-testid={`journey-lane-${lane.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold text-slate-900">{lane.title}</h3>
          <p className="text-xs text-slate-700" data-testid={`journey-summary-${lane.id}`}>{summaryText(lane)}</p>
        </div>
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700 min-[701px]:hidden">
          {lane.title} stations<span aria-hidden className="ml-1.5">{open ? "\u25B4" : "\u25BE"}</span>
        </button>
      </div>
      <div id={bodyId} className={open ? "" : "max-[700px]:hidden"} data-testid={`journey-body-${lane.id}`}>
        {lane.stations.length === 0
          ? <p className="py-3 text-xs text-slate-600">No variations have been raised.</p>
          : <ul className="divide-y divide-slate-100" aria-labelledby={id}>{lane.stations.map((s) => <StationRow key={s.id} s={s} onOpenTab={onOpenTab} />)}</ul>}
      </div>
    </div>
  );
}

export function JourneyMap({ journey, onOpenTab }: { journey: Journey; onOpenTab: (tab: OverviewTab) => void }) {
  // Lanes, and the key with the Setup strip, are collapsed to a summary on a phone and always shown from 701px up (CSS decides; this only records what the viewer opened).
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const toggle = (k: string) => setOpen((o) => ({ ...o, [k]: !o[k] }));
  const needing = [...journey.setup.filter((s) => !s.unknown && (s.status === "needs_attention" || s.status === "blocked")), ...journey.lanes.flatMap((l) => l.stations.filter((s) => !s.unknown && (s.status === "needs_attention" || s.status === "blocked")))].length;
  const setupOpen = !!open.setup;
  return (
    <section aria-labelledby="ov-journey" className="space-y-3" data-testid="journey">
      <div>
        <h2 id="ov-journey" className="text-sm font-semibold text-slate-800">Project journey</h2>
        <p className="text-xs text-slate-600">Where each workflow stands. These run in parallel; none has to be finished before another, and nothing here blocks you from working.</p>
        <p className="mt-1 text-xs font-medium text-slate-800" data-testid="journey-total">{needing === 0 ? "No station needs attention." : `${needing} station${needing === 1 ? "" : "s"} need${needing === 1 ? "s" : ""} attention or ${needing === 1 ? "is" : "are"} blocked.`}</p>
      </div>
      <div className="min-[701px]:hidden">
        <button type="button" aria-expanded={setupOpen} aria-controls="journey-setup-group" onClick={() => toggle("setup")}
          className="inline-flex min-h-11 items-center rounded-md border border-slate-300 px-3 text-xs font-medium text-slate-800 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-700">
          Key and setup<span aria-hidden className="ml-1.5">{setupOpen ? "\u25B4" : "\u25BE"}</span>
        </button>
      </div>
      <div id="journey-setup-group" className={`space-y-3 ${setupOpen ? "" : "max-[700px]:hidden"}`} data-testid="journey-setup-group">
        <ul className="flex flex-wrap gap-x-4 gap-y-1" aria-label="Status key" data-testid="journey-key">
          {KEY.map((k) => <li key={k}><Status tone={TONE[k]}>{JOURNEY_STATUS_LABEL[k]}</Status></li>)}
          <li className="text-xs text-slate-700">&ldquo;{JOURNEY_UNKNOWN_LABEL}&rdquo; means the Toolbox has not loaded that value: it is not zero.</li>
        </ul>
        <div className="rounded-xl border border-slate-200 bg-white px-4 py-3" data-testid="journey-setup">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-600">Setup</h3>
          <ul className="grid gap-x-6 divide-y divide-slate-100 min-[701px]:grid-cols-3 min-[701px]:divide-y-0">
            {journey.setup.map((s) => <StationRow key={s.id} s={s} onOpenTab={onOpenTab} />)}
          </ul>
        </div>
      </div>
      <div className="grid gap-3 min-[1100px]:grid-cols-3">
        {journey.lanes.map((l) => <Lane key={l.id} lane={l} id={`journey-lane-h-${l.id}`} open={!!open[l.id]} onToggle={() => toggle(l.id)} onOpenTab={onOpenTab} />)}
      </div>
      <p className="text-xs text-slate-600" data-testid="journey-footnote">{journey.footnote}</p>
    </section>
  );
}
