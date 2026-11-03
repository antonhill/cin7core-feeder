"use client";

import { useRef, useState } from "react";
import { Status } from "@/components/ui/Status";
import type { BadgeTone } from "@/components/ui/Badge";
import type { StageId, StageStatus, StageView } from "@/newquip/quote/stages";
import { navStatusLabel } from "@/newquip/quote/stage-nav-model";

// The six-stage navigation of the Solution Builder. Pure presentation of computeStages(): the status of every stage is derived from the quotation's existing state and
// immutable records, and selecting a stage only changes what is shown - every action is still authorised on the server.
const TONE: Record<StageStatus, BadgeTone> = { LOADING: "neutral", COMPLETE: "success", IN_PROGRESS: "info", AWAITING_ACTION: "warning", RETURNED: "danger", NOT_STARTED: "neutral", NOT_AVAILABLE: "neutral", NOT_REQUIRED: "neutral" };

// At 700px and below the six cards collapse to a disclosure "Stage n of 6 · name" that lists all six with their status (every stage stays reachable).
export function StageNav({ stages, current, viewing, onSelect, previewable = [], viewer }: { stages: StageView[]; current: StageId; viewing: StageId; onSelect: (id: StageId) => void; /** Unavailable stages the page can show read-only (labelled "Preview only"). */ previewable?: readonly StageId[]; /** The viewer's roles and the quote state, for viewer-relative wording of the status chip only. */ viewer?: { roles: readonly string[]; state: string } }) {
  const [open, setOpen] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  // Closing the list hides the focused button (display:none), which would drop focus to <body>: move it to the toggle instead (only when the list was open).
  const close = () => { if (open) { setOpen(false); toggle.current?.focus(); } };
  const cur = stages.find((s) => s.id === current);
  const view = stages.find((s) => s.id === viewing);
  return (
    <div className="mt-6 space-y-3" data-testid="stage-nav">
      <nav aria-label="Quotation stages" onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}>
        <button ref={toggle} type="button" aria-expanded={open} aria-controls="stage-nav-list" onClick={() => setOpen((o) => !o)} data-testid="stage-nav-toggle"
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm font-semibold text-slate-900 min-[701px]:hidden">
          <span>Stage {viewing} of {stages.length} · {view?.label ?? ""}</span><span aria-hidden>{open ? "▲" : "▼"}</span>
        </button>
        <ol id="stage-nav-list" className={`${open ? "grid" : "hidden"} mt-2 grid-cols-1 gap-2 min-[701px]:mt-0 min-[701px]:grid sm:grid-cols-2 lg:grid-cols-6`}>
          {stages.map((s) => {
            const on = s.id === viewing;
            return (
              <li key={s.id}>
                <button type="button" onClick={() => { onSelect(s.id); close(); }} aria-current={on ? "step" : undefined} data-stage={s.id}
                  className={`flex h-full min-h-11 w-full flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${on ? "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-600" : "border-slate-200 bg-white hover:bg-slate-50"}${s.status === "NOT_AVAILABLE" && !on ? " border-dashed bg-slate-50" : ""}`}>
                  {/* Every card has the same three zones: a header of fixed height (room for "Stage n · you are here" on two lines, so the title always starts at the same offset), the title
                      (grows, never truncated) and the status chip pinned to the bottom. The row is as tall as its tallest card. */}
                  <span className="block w-full lg:min-h-8 text-xs font-semibold text-slate-600">Stage {s.id}{s.id === current ? " · you are here" : ""}</span>
                  <span className="text-sm font-semibold text-slate-900">{s.label}</span>
                  <span className="mt-auto pt-1"><Status tone={TONE[s.status]}>{navStatusLabel(s, previewable.includes(s.id), viewer)}</Status></span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      {cur && (
        <p className="rounded-lg border border-slate-200 bg-white px-4 py-2 text-sm text-slate-700" data-testid="next-action">
          <span className="font-semibold text-slate-900">Stage {cur.id} · {cur.label}:</span> {cur.summary}{cur.next ? <> <span className="font-semibold text-indigo-700">Next: {cur.next}</span></> : null}
        </p>
      )}
    </div>
  );
}
