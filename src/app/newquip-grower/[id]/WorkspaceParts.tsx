"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { money, type CompleteLine, type IndicatorState, type NextAction, type Summary, type TaskIndicators, type TaskTag, type WorkspaceTask } from "@/newquip/quote/estimator-workspace";

// Presentational pieces of the Estimator workspace (the approved design): compact four-indicator rows, the legend, the next-action bar, the completed group, the commercial summary
// and the "what happens next" path. They render what estimator-workspace.ts derived; they decide nothing and do no arithmetic.

const INDICATOR_NAMES: Array<[keyof TaskIndicators, string, string]> = [["mapping", "M", "Mapping"], ["price", "S", "Selling price"], ["cost", "C", "Supplier cost"], ["verified", "V", "Verified"]];
const WORD: Record<IndicatorState, string> = { done: "complete", open: "needed", wait: "not yet", na: "not applicable" };
const GLYPH: Record<IndicatorState, string> = { done: "✓", open: "–", wait: "·", na: "" };
const CLASS: Record<IndicatorState, string> = {
  done: "bg-emerald-700 text-white border-emerald-700",
  open: "bg-white text-amber-900 border-amber-600",
  wait: "bg-white text-slate-600 border-slate-300",
  na: "bg-slate-100 text-slate-700 border-slate-200",
};

export function Indicator({ state, name, size = 26 }: { state: IndicatorState; name: string; size?: number }) {
  return (
    <span role="img" aria-label={`${name} ${WORD[state]}`} title={`${name} ${WORD[state]}`} style={{ width: size, height: size }} className={`inline-flex shrink-0 items-center justify-center rounded-full border-2 text-[13px] font-bold ${CLASS[state]}`}>{GLYPH[state]}</span>
  );
}

export function Indicators({ value, testId }: { value: TaskIndicators; testId?: string }) {
  return (
    <div className="flex shrink-0 gap-1.5" data-testid={testId}>
      {INDICATOR_NAMES.map(([k, , name]) => <Indicator key={k} state={value[k]} name={name} />)}
    </div>
  );
}

export function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-700" aria-label="Legend" data-testid="indicator-legend">
      {INDICATOR_NAMES.map(([k, letter, name]) => <span key={k}><span className="mr-1.5 inline-flex size-[22px] items-center justify-center rounded bg-slate-200 text-xs font-bold text-slate-900">{letter}</span>{name}</span>)}
      <span className="inline-flex items-center gap-1"><Indicator state="done" name="Done" size={18} />done <Indicator state="open" name="Needed" size={18} />needed <Indicator state="wait" name="Not yet" size={18} />not yet</span>
    </div>
  );
}

const TAG_CLASS: Record<TaskTag, string> = { PRICE: "bg-blue-700 text-white", COST: "bg-blue-700 text-white", PRODUCT: "border-2 border-purple-800 bg-white text-purple-900", COMPONENTS: "border-2 border-purple-800 bg-white text-purple-900" };
export const Tag = ({ t }: { t: TaskTag }) => <span className={`inline-flex h-[22px] items-center rounded px-2 text-xs font-bold tracking-wide ${TAG_CLASS[t]}`}>{t}</span>;

export function TaskRow({ task, active, onOpen, canEdit }: { task: WorkspaceTask; active: boolean; onOpen: () => void; canEdit: boolean }) {
  return (
    <li className={`flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-3 sm:px-6 ${active ? "bg-sky-50" : ""}`} data-testid={`task-${task.id}`}>
      <span className={`flex size-[26px] shrink-0 items-center justify-center rounded-full border-2 text-[13px] font-bold ${active ? "border-blue-700 bg-blue-700 text-white" : "border-slate-600 text-slate-900"}`} aria-hidden>{task.n}</span>
      <div className="min-w-0 flex-[1_1_14rem]">
        <div className="flex flex-wrap items-center gap-2"><strong className="text-[15px] text-slate-900">{task.label}</strong>{task.tags.map((t) => <Tag key={t} t={t} />)}<span className="text-sm tabular-nums text-slate-600">{task.meta}</span></div>
        <p className="mt-0.5 text-[13.5px] text-slate-900">{task.why}</p>
      </div>
      <Indicators value={task.indicators} testId={`indicators-${task.id}`} />
      <Button type="button" variant={active ? "primary" : "secondary"} className="min-h-11 w-full sm:w-[150px]" onClick={onOpen} disabled={!canEdit} aria-label={`${task.action}: ${task.label}`}>{task.action}</Button>
    </li>
  );
}

export function NextActionBar({ next, onAction }: { next: NextAction; onAction: (() => void) | null }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl bg-sky-950 px-6 py-4 text-white" data-testid="next-action" role="status">
      <div className="min-w-0 flex-[1_1_16rem]"><p className="text-xs font-semibold tracking-widest opacity-85">NEXT ACTION</p><p className="mt-0.5 text-xl font-bold">{next.headline}</p>{next.detail && <p className="mt-0.5 text-sm opacity-90">{next.detail}</p>}</div>
      {next.button && onAction && <button type="button" onClick={onAction} className="inline-flex min-h-11 items-center rounded-lg bg-white px-5 text-sm font-semibold text-sky-950 hover:bg-slate-100">{next.button}</button>}
    </div>
  );
}

export function CompleteGroup({ lines, charges, onEdit, canEdit }: { lines: CompleteLine[]; charges: Array<{ label: string; amountExTax: number | null }>; onEdit: (id: string) => void; canEdit: boolean }) {
  const chargesTotal = charges.reduce((a, c) => a + (c.amountExTax ?? 0), 0);
  return (
    <section aria-labelledby="ws-complete" className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="complete-group">
      <div className="border-b border-slate-200 px-4 py-3 sm:px-6"><h2 id="ws-complete" className="text-lg font-bold text-emerald-800">Complete <span className="font-medium text-slate-700">· {lines.length} line{lines.length === 1 ? "" : "s"}, {charges.length} charge{charges.length === 1 ? "" : "s"}</span></h2></div>
      <div className="overflow-x-auto"><table className="w-full min-w-[480px] text-sm">
        <thead><tr className="text-left text-xs text-slate-700"><th className="px-4 py-2 font-semibold sm:px-6">LINE</th><th className="px-2 py-2 font-semibold">HOW IT WAS RESOLVED</th><th className="px-2 py-2 text-right font-semibold">QTY × UNIT</th><th className="px-4 py-2 text-right font-semibold sm:px-6">EX VAT</th></tr></thead>
        <tbody>
          {lines.map((c) => (
            <tr key={c.id} className="border-t border-slate-200" data-testid={`complete-${c.id}`}>
              <td className="px-4 py-2.5 sm:px-6"><span aria-hidden className="text-emerald-700">✓ </span>{c.label}{c.provisional && <span className="ml-2 rounded bg-amber-800 px-1.5 py-0.5 text-xs font-bold text-white">PROVISIONAL</span>}</td>
              <td className="px-2 py-2.5 text-slate-700">{c.how}{!c.estimatorPriced && canEdit && <> · <button type="button" className="font-semibold text-blue-800 underline" onClick={() => onEdit(c.id)}>Edit</button></>}</td>
              <td className="px-2 py-2.5 text-right tabular-nums">{c.quantity ?? "—"} × {c.unit == null ? "—" : money(c.unit)}</td>
              <td className="px-4 py-2.5 text-right font-semibold tabular-nums sm:px-6">{c.revenue == null ? "—" : money(c.revenue)}</td>
            </tr>
          ))}
          <tr className="border-t border-slate-200 bg-slate-50"><td className="px-4 py-2.5 text-slate-700 sm:px-6" colSpan={3}>Charges: {charges.map((c) => `${c.label.toLowerCase()} ${c.amountExTax == null ? "not entered" : money(c.amountExTax)}`).join(" · ")}</td><td className="px-4 py-2.5 text-right font-semibold tabular-nums sm:px-6">{money(chargesTotal)}</td></tr>
        </tbody>
      </table></div>
    </section>
  );
}

export function SummaryPanel({ s }: { s: Summary }) {
  const tone = s.totalKind === "partial" ? "border-amber-600 bg-amber-50 text-amber-950" : s.totalKind === "calculated" ? "border-amber-600 bg-amber-50 text-amber-950" : "border-emerald-600 bg-emerald-50 text-emerald-950";
  const check = (c: { done: number; of: number }) => `${c.done} of ${c.of}`;
  return (
    <aside aria-labelledby="ws-sum" className="flex min-w-0 flex-col gap-3 rounded-xl border border-slate-200 bg-white p-5" data-testid="commercial-summary">
      <h2 id="ws-sum" className="text-lg font-bold">Commercial summary</h2>
      <div className={`rounded-lg border px-3 py-2 text-[12.5px] font-bold tracking-wide ${tone}`} data-testid="summary-kind">{s.totalKind === "partial" ? "PARTIAL AND INDICATIVE. NOT A CONTRACT VALUE." : s.totalLabel}</div>
      <div className="flex justify-between text-sm"><span>Lines with a selling price ({s.pricedLineCount})</span><span className="tabular-nums">{money(s.pricedLinesExVat)}</span></div>
      <div className="flex justify-between text-sm"><span>Charges</span><span className="tabular-nums">{money(s.chargesExVat)}</span></div>
      {s.unpricedLineCount > 0 && <div className="flex justify-between text-sm font-semibold text-amber-900"><span>No price yet ({s.unpricedLineCount} line{s.unpricedLineCount === 1 ? "" : "s"})</span><span>not in total</span></div>}
      <div className="flex justify-between border-t-2 border-slate-900 pt-2 text-base font-bold"><span>{s.totalKind === "partial" ? "Partial total, ex VAT" : s.totalKind === "calculated" ? "Calculated total, ex VAT" : "Total, ex VAT"}</span><span className="tabular-nums" data-testid="summary-total">{money(s.totalExVat)}</span></div>
      <div className="flex justify-between text-sm text-slate-600"><span>VAT 15%{s.totalKind === "partial" ? " on this partial" : ""}</span><span className="tabular-nums">{money(s.vat)}</span></div>
      <div className="flex justify-between text-sm text-slate-600"><span>Incl VAT{s.totalKind === "partial" ? ", partial" : ""}</span><span className="tabular-nums">{money(s.totalIncVat)}</span></div>
      {s.confirmedCents !== null && (
        <div className="rounded-lg border border-amber-600 bg-amber-50 p-3 text-[13px] text-amber-950" data-testid="summary-confirmed">
          <div className="flex justify-between"><span>Rep confirmed</span><strong className="tabular-nums">{money(s.confirmedCents / 100)}</strong></div>
          {s.differenceCents !== null && s.differenceCents !== 0 && <div className="mt-1 flex justify-between"><span>{s.totalKind === "partial" ? "Partial total is" : "Total is"} {s.differenceCents > 0 ? "higher" : "lower"} by</span><strong className="tabular-nums">{money(Math.abs(s.differenceCents) / 100)}</strong></div>}
          {s.differenceCents !== 0 && <p className="mt-2">{s.totalKind === "partial" ? "The gap will grow as lines are priced. " : ""}The Rep reconfirms the final amount before anyone verifies costs.</p>}
        </div>
      )}
      <div className="flex flex-col gap-1.5 border-t border-slate-200 pt-3 text-sm" data-testid="four-checks">
        <p className="text-xs font-bold tracking-widest text-slate-600">FOUR SEPARATE CHECKS</p>
        <div className="flex justify-between"><span>Mapping complete</span><span className="tabular-nums">{check(s.checks.mapping)}</span></div>
        <div className="flex justify-between"><span>Selling price complete</span><span className="tabular-nums">{check(s.checks.price)}</span></div>
        <div className="flex justify-between"><span>Supplier cost complete</span><span className="tabular-nums">{check(s.checks.cost)}</span></div>
        <div className="flex justify-between"><span>Independently verified</span><span className="tabular-nums">{check(s.checks.verified)}</span></div>
      </div>
      <div className="border-t border-slate-200 pt-3 text-sm" data-testid="summary-margin"><div className="flex justify-between"><span>Margin</span><span className={s.marginLabel === "indicative" ? "font-semibold text-amber-900" : "text-slate-600"}>{s.marginLabel === "none" ? "none yet" : s.marginLabel === "indicative" ? "indicative, unverified" : "verified"}</span></div><p className="mt-1 text-xs text-slate-700">{s.marginNote}</p></div>
      {s.blockers.length > 0 && <div className="border-t border-slate-200 pt-3 text-[13px] text-slate-700"><strong className="text-slate-900">Sign-off is blocked by</strong><ol className="mt-1.5 list-decimal pl-5">{s.blockers.map((b) => <li key={b}>{b}</li>)}</ol></div>}
    </aside>
  );
}

export function WhatNext({ step, verified, required }: { step: 1 | 2 | 3 | 4 | 5; verified: number; required: number }): ReactNode {
  const items: Array<[string, string]> = [["You", "price the open tasks. A changed amount goes back to the Rep."], ["Rep", "confirms the new amount with the customer."], ["A Manager", `verifies each supplier cost independently (${verified} of ${required} now). You cannot verify your own entries.`], ["You", "sign off. Locked until the amount is confirmed and costs are verified."], ["A Manager", "approves. No automatic waiver."]];
  return (
    <aside aria-labelledby="ws-next" className="rounded-xl border border-slate-200 bg-white p-5" data-testid="what-next">
      <h2 id="ws-next" className="text-lg font-bold">What happens next</h2>
      <ol className="mt-3 flex flex-col gap-2.5 text-sm">{items.map(([who, what], i) => <li key={i} aria-current={step === i + 1 ? "step" : undefined} className={step === i + 1 ? "rounded-md bg-sky-50 px-2 py-1 font-semibold" : "px-2 py-1"}><strong>{who}:</strong> <span className="font-normal text-slate-800">{what}</span></li>)}</ol>
      <p className="mt-3 border-t border-slate-200 pt-2 text-xs text-slate-600">Where a price changes, the Rep reconfirms first, then a Manager verifies costs, then you sign off, then a Manager approves.</p>
    </aside>
  );
}
