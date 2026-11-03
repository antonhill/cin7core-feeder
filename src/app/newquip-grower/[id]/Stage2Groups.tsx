"use client";

import { Status } from "@/components/ui/Status";
import type { Stage2Group } from "@/newquip/quote/stage2-steps";

// Stage 2's two responsibility groups: who prepares, who reviews, each with ITS OWN progress and a workflow status line derived from the quotation's own state (stage2-steps.ts).
// Presentation only: it names no cost or margin, and the Cost & margin step is counted only for a viewer who has it.
export function Stage2Groups({ groups, youAre }: { groups: Stage2Group[]; youAre: ReadonlySet<string> }) {
  return (
    <ul className="mt-4 grid gap-3 md:grid-cols-2" aria-label="Who does what in this stage" data-testid="stage2-groups">
      {groups.map((g) => (
        <li key={g.id} className="rounded-lg border border-slate-200 bg-white p-3" data-group={g.id}>
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <span className="text-sm font-semibold text-slate-900">{g.label}{youAre.has(g.id) ? <span className="ml-2 text-xs font-medium text-slate-700">(your work)</span> : null}</span>
            <span className="text-xs font-semibold text-slate-800" data-testid={`group-progress-${g.id}`}>{g.progress}{g.attention > 0 ? ` · ${g.attention} need attention` : ""}</span>
          </div>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-slate-800"><span className="text-xs uppercase tracking-wide text-slate-700">Workflow</span><Status tone={g.tone}><span data-testid={`group-status-${g.id}`}>{g.statusLine}</span></Status></p>
        </li>
      ))}
    </ul>
  );
}
