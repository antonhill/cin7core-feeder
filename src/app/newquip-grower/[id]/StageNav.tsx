"use client";

import { Badge, type BadgeTone } from "@/components/ui/Badge";
import type { StageId, StageStatus, StageView } from "@/newquip/quote/stages";

// The six-stage navigation of the Solution Builder. Pure presentation of computeStages(): the status of every stage is derived from the quotation's existing state and
// immutable records, and selecting a stage only changes what is shown - every action is still authorised on the server.
const TONE: Record<StageStatus, BadgeTone> = { COMPLETE: "success", IN_PROGRESS: "info", AWAITING_ACTION: "warning", RETURNED: "danger", NOT_STARTED: "neutral", NOT_AVAILABLE: "neutral", NOT_REQUIRED: "neutral" };

export function StageNav({ stages, current, viewing, onSelect }: { stages: StageView[]; current: StageId; viewing: StageId; onSelect: (id: StageId) => void }) {
  const cur = stages.find((s) => s.id === current);
  return (
    <div className="mt-6 space-y-3" data-testid="stage-nav">
      <nav aria-label="Quotation stages">
        <ol className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-6">
          {stages.map((s) => {
            const on = s.id === viewing;
            return (
              <li key={s.id}>
                <button type="button" onClick={() => onSelect(s.id)} aria-current={on ? "step" : undefined} data-stage={s.id}
                  className={`flex h-full w-full flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors ${on ? "border-indigo-600 bg-indigo-50 ring-2 ring-indigo-600" : "border-slate-200 bg-white hover:bg-slate-50"} ${s.status === "NOT_AVAILABLE" ? "opacity-70" : ""}`}>
                  <span className="flex w-full items-center justify-between gap-2 text-xs font-semibold text-slate-500">
                    <span>Stage {s.id}{s.id === current ? " · you are here" : ""}</span>
                  </span>
                  <span className="text-sm font-semibold text-slate-900">{s.label}</span>
                  <Badge tone={TONE[s.status]} dot>{s.statusLabel}</Badge>
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
