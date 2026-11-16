"use client";

import type { ReactNode } from "react";

// ONE COLLAPSIBLE SECTION of the Estimator's checklist on the modern Phase 2 screen. Used while supplier costing is not on yet, so mapping, package confirmation, pricing exceptions, the final readiness review and
// sign-off or return are all reachable from the same screen as the first task, without entering the older wizard. It only WRAPS the existing panels (their controls, gates and server actions are unchanged):
// a short title, a plain status and a disclosure. `wrap=false` renders the children untouched (every other screen).
export function EstimatorSection({ wrap, id, number, title, status, tone, openByDefault = false, children }: {
  wrap: boolean; id: string; number: number; title: string; status: string; tone: "ok" | "open"; openByDefault?: boolean; children: ReactNode;
}) {
  if (!wrap) return <>{children}</>;
  return (
    <details open={openByDefault} className="rounded-xl border border-slate-200 bg-white" data-testid={`est-section-${id}`}>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
        <span className="flex size-7 items-center justify-center rounded-full border border-slate-400 text-sm font-bold text-slate-900" aria-hidden>{number}</span>
        <span className="text-base font-bold text-slate-900">{title}</span>
        <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${tone === "ok" ? "border-emerald-700 bg-emerald-50 text-emerald-900" : "border-amber-600 bg-amber-50 text-amber-900"}`} data-testid={`est-section-status-${id}`}>{status}</span>
      </summary>
      <div className="border-t border-slate-200 px-3 py-3 sm:px-5">{children}</div>
    </details>
  );
}
