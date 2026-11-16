"use client";

import type { ReactNode } from "react";

// THE SHARED HEADER for Phases 1, 3 and 4 (Phase 2's workspace header is the visual reference): which quotation, who for, where it is, up to three labelled figures, the one-line phase navigation
// and a single Details disclosure for everything secondary. Presentational only: every figure and handler is passed in by the page from data it already holds.
export interface HeaderFigure { label: string; labelTestId?: string; value: string; note?: string; tone?: "plain" | "warn" | "ok"; testId?: string }
export type HeaderTone = "neutral" | "warn" | "ok";

const CHIP: Record<HeaderTone, string> = {
  neutral: "border-slate-500 bg-slate-50 text-slate-900",
  warn: "border-amber-600 bg-amber-50 text-amber-900",
  ok: "border-emerald-700 bg-emerald-50 text-emerald-900",
};
const LABEL: Record<NonNullable<HeaderFigure["tone"]>, string> = { plain: "text-slate-600", warn: "text-amber-900", ok: "text-emerald-800" };

export function PhaseHeader({ name, reference, customer, rooms, basis, status, tone = "neutral", figures, phases, details, nextAction }: {
  name: string; reference: string; customer: string; rooms: number; basis: string; status: string; tone?: HeaderTone; figures: HeaderFigure[]; phases?: ReactNode; details?: ReactNode; nextAction?: ReactNode;
}) {
  return (
    <header className="mt-3 rounded-xl border border-slate-200 bg-white px-5 py-3" data-testid="phase-header">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="text-xl font-bold text-slate-900" data-testid="phase-header-name">{name}</h2>
            <span className={`rounded border px-2 py-0.5 text-xs font-bold tracking-wide ${CHIP[tone]}`} data-testid="phase-header-status">{status}</span>
          </div>
          <p className="mt-0.5 text-sm text-slate-700" data-testid="phase-header-sub">{reference} · {customer} · {rooms} room{rooms === 1 ? "" : "s"} · {basis}</p>
        </div>
        {figures.map((f) => (
          <div key={f.label} className="min-w-0 flex-[0_1_15rem]">
            <p className={`text-xs font-semibold uppercase tracking-wider ${LABEL[f.tone ?? "plain"]}`} data-testid={f.labelTestId}>{f.label}</p>
            <p className="whitespace-nowrap text-xl font-bold tabular-nums text-slate-900" data-testid={f.testId}>{f.value}</p>
            {f.note && <p className="text-xs text-slate-700">{f.note}</p>}
          </div>
        ))}
      </div>
      {nextAction && <p className="mt-2 border-t border-slate-100 pt-2 text-sm text-slate-700" data-testid="next-action">{nextAction}</p>}
      {(phases || details) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-100 pt-2">
          {phases}
          {details && <details className="w-full" data-testid="phase-header-details"><summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-blue-800 underline">Details and history</summary><div className="mt-2 flex flex-col gap-3 text-sm">{details}</div></details>}
        </div>
      )}
    </header>
  );
}
