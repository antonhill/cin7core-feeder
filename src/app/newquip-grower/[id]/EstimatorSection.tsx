"use client";

import { useState, type ReactNode } from "react";

// ONE COLLAPSIBLE SECTION of the Estimator's checklist on the modern Phase 2 screen. Used while supplier costing is not on yet, so mapping, package confirmation, pricing exceptions, the final readiness review and
// sign-off or return are all reachable from the same screen as the first task, without entering the older wizard. It only WRAPS the existing panels (their controls, gates and server actions are unchanged):
// a short title, a plain status and a disclosure. `wrap=false` renders the children untouched (every other screen). The section is opened by the Estimator (or at first when it needs attention) and is never
// closed by the page while they work in it; `forceOpen` opens it when its action reports (so a result or error is never hidden inside a closed section).
export function EstimatorSection({ wrap, id, number, title, status, tone, openByDefault = false, forceOpen = false, children }: {
  wrap: boolean; id: string; number: number; title: string; status: string; tone: "ok" | "open"; openByDefault?: boolean; forceOpen?: boolean; children: ReactNode;
}) {
  const [open, setOpen] = useState(openByDefault);
  // Opens when its action starts reporting (React's documented "adjust state while rendering" pattern); never closes it again by itself.
  const [prevForce, setPrevForce] = useState(forceOpen);
  if (forceOpen !== prevForce) { setPrevForce(forceOpen); if (forceOpen) setOpen(true); }
  if (!wrap) return <>{children}</>;
  return (
    <details open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)} className="rounded-xl border border-slate-200 bg-white" data-testid={`est-section-${id}`}>
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 sm:px-5">
        <span className="flex size-7 items-center justify-center rounded-full border border-slate-400 text-sm font-bold text-slate-900" aria-hidden>{number}</span>
        <span className="text-base font-bold text-slate-900">{title}</span>
        <span className={`rounded border px-2 py-0.5 text-xs font-semibold ${tone === "ok" ? "border-emerald-700 bg-emerald-50 text-emerald-900" : "border-amber-600 bg-amber-50 text-amber-900"}`} data-testid={`est-section-status-${id}`}>{status}</span>
      </summary>
      <div className="border-t border-slate-200 px-3 py-3 sm:px-5">{children}</div>
    </details>
  );
}
