"use client";

import { useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { MIN_EVIDENCE_NOTE, MAX_EVIDENCE_NOTE } from "@/newquip/pricing/estimator/manual-evidence";
import { money, type CompleteLine, type IndicatorState, type NextAction, type StatusWord, type Summary, type TaskIndicators, type TaskTag, type WorkspaceTask } from "@/newquip/quote/estimator-workspace";

// Presentational pieces of the Estimator workspace (the approved design): compact four-indicator rows, the legend, the next-action bar, the completed group, the commercial summary
// and the "what happens next" path. They render what estimator-workspace.ts derived; they decide nothing and do no arithmetic.

const WORD: Record<IndicatorState, string> = { done: "done", open: "needed", wait: "not yet", na: "not applicable" };
const CHECKS: Array<[keyof TaskIndicators, string]> = [["mapping", "Mapping"], ["price", "Selling price"], ["cost", "Supplier cost"], ["verified", "Verified"]];

/** The four underlying readiness checks of ONE product, as a small list for the product editor (never in the primary rows). */
export function ReadinessList({ value }: { value: TaskIndicators }) {
  return (
    <ul aria-label="Readiness checks" className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-700" data-testid="editor-readiness">
      {CHECKS.filter(([k]) => value[k] !== "na").map(([k, name]) => <li key={k}><span className="text-slate-600">{name}:</span> <strong className={value[k] === "done" ? "text-emerald-800" : value[k] === "open" ? "text-amber-900" : "text-slate-600"}>{WORD[value[k]]}</strong></li>)}
    </ul>
  );
}

const STATUS_CLASS: Record<StatusWord, string> = {
  "Confirmation needed": "bg-amber-100 text-amber-950", "Supplier cost needed": "bg-amber-100 text-amber-950", "Product selection needed": "bg-amber-100 text-amber-950", "Component pricing needed": "bg-amber-100 text-amber-950", "Price needed": "bg-amber-100 text-amber-950",
  "Evidence needed": "bg-amber-100 text-amber-950", Provisional: "bg-amber-800 text-white", Complete: "bg-emerald-100 text-emerald-900",
};
export const StatusChip = ({ word }: { word: StatusWord }) => <span className={`inline-flex items-center whitespace-nowrap rounded px-2 py-0.5 text-xs font-bold ${STATUS_CLASS[word]}`} data-testid="row-status">{word}</span>;

const TAG_CLASS: Record<TaskTag, string> = { PRICE: "bg-blue-700 text-white", COST: "bg-blue-700 text-white", PRODUCT: "border-2 border-purple-800 bg-white text-purple-900", COMPONENTS: "border-2 border-purple-800 bg-white text-purple-900" };
export const Tag = ({ t }: { t: TaskTag }) => <span className={`inline-flex h-[22px] items-center rounded px-2 text-xs font-bold tracking-wide ${TAG_CLASS[t]}`}>{t}</span>;

/** ONE line of the open list: its name, ONE plain-English status and ONE action button. The four readiness checks live in the product editor. */
export function OpenRow({ n, id, plain, testId, dataState, label, tags, meta, why, status, action, active, onAct, canEdit, children }: { n: number; id: string; plain?: boolean; testId?: string; dataState?: string; label: string; tags?: TaskTag[]; meta: string; why: string; status: StatusWord; action: string; active: boolean; onAct: () => void; canEdit: boolean; children?: ReactNode }) {
  return (
    <li className={`border-b border-slate-200 px-4 py-2.5 sm:px-5 ${active ? "bg-sky-50" : ""}`} data-testid={testId ?? `task-${id}`} data-state={dataState}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className={`flex size-6 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold ${active ? "border-blue-700 bg-blue-700 text-white" : "border-slate-600 text-slate-900"}`} aria-hidden>{n}</span>
        <div className="min-w-0 flex-[1_1_14rem]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><strong className="text-[15px] text-slate-900">{label}</strong><StatusChip word={status} />{(tags ?? []).map((t) => <Tag key={t} t={t} />)}<span className="text-sm tabular-nums text-slate-600">{meta}</span></div>
          <p className="mt-0.5 text-[13px] text-slate-800">{why}</p>
        </div>
        <Button type="button" variant={active ? "primary" : "secondary"} className="min-h-11 w-full sm:w-[150px]" onClick={onAct} disabled={!canEdit} aria-label={plain ? undefined : `${action}: ${label}`}>{action}</Button>
      </div>
      {children}
    </li>
  );
}

export function NextActionBar({ next, onAction }: { next: NextAction; onAction: (() => void) | null }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-sky-950 px-5 py-3 text-white" data-testid="next-action" role="status">
      <div className="min-w-0 flex-[1_1_16rem]"><p className="text-xs font-semibold tracking-widest opacity-85">NEXT ACTION</p><p className="text-lg font-bold leading-snug">{next.headline}</p>{next.detail && <p className="mt-0.5 text-sm opacity-90">{next.detail}</p>}</div>
      {next.button && onAction && <button type="button" onClick={onAction} className="inline-flex min-h-11 items-center rounded-lg bg-white px-5 text-sm font-semibold text-sky-950 hover:bg-slate-100">{next.button}</button>}
    </div>
  );
}

/** The form that records the pricing evidence for a SKU-less manual line (the EXISTING action; it never changes a price and the server binds the note to the current price). */
export function EvidenceForm({ line, onRecord, onDone }: { line: CompleteLine; onRecord: (itemKey: string, note: string, reference: string) => Promise<{ ok: boolean; errors?: string[] }>; onDone: () => void }) {
  const ev = line.evidence!;
  const [note, setNote] = useState(ev.note ?? "");
  const [ref, setRef] = useState(ev.reference ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const valid = note.trim().length >= MIN_EVIDENCE_NOTE && note.trim().length <= MAX_EVIDENCE_NOTE;
  async function save() { setBusy(true); setErr(null); try { const r = await onRecord(line.id, note.trim(), ref.trim()); if (!r.ok) setErr(r.errors?.[0] ?? "Could not record the evidence."); else onDone(); } catch { setErr("That did not complete. Nothing was recorded."); } finally { setBusy(false); } }
  return (
    <div className="mt-2 flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3">
      <div className="min-w-[16rem] flex-[2_1_16rem]"><Input label="What this price is based on" value={note} onChange={(e) => setNote(e.target.value)} helperText={`At least ${MIN_EVIDENCE_NOTE} characters (for example a supplier quote reference and date).`} /></div>
      <div className="min-w-[8rem] flex-[1_1_8rem]"><Input label="Reference (optional)" value={ref} onChange={(e) => setRef(e.target.value)} /></div>
      <Button type="button" className="min-h-11" loading={busy} disabled={busy || !valid} onClick={save}>Save evidence</Button>
      {err && <p className="w-full text-sm text-amber-900" data-testid="evidence-error">{err}</p>}
    </div>
  );
}

/** A line in the OPEN list whose only open item is its pricing-evidence record: status "Evidence needed", one "Record evidence" button that opens the existing form under the row. */
export function EvidenceOpenRow({ n, line, canEdit, onRecord }: { n: number; line: CompleteLine; canEdit: boolean; onRecord: (itemKey: string, note: string, reference: string) => Promise<{ ok: boolean; errors?: string[] }> }) {
  const [open, setOpen] = useState(false);
  const ev = line.evidence!;
  const what = line.provisional ? "Manual quotation price, provisional. " : "";
  return (
    <OpenRow n={n} id={line.id} plain testId={`evidence-${line.id}`} dataState={ev.state} label={line.label} meta={`${line.quantity ?? "—"} × ${line.unit == null ? "—" : money(line.unit)}`} status="Evidence needed" action={open ? "Hide form" : "Record evidence"} active={false} canEdit={canEdit} onAct={() => setOpen((o) => !o)}
      why={`${what}Pricing evidence: ${ev.text}. It is needed before sign-off and changes no price.`}>
      {open && <EvidenceForm line={line} onRecord={onRecord} onDone={() => setOpen(false)} />}
    </OpenRow>
  );
}

/** The existing pricing-evidence state of a COMPLETE line (recorded evidence can be changed; nothing is needed). */
function EvidenceRecorder({ line, canEdit, onRecord }: { line: CompleteLine; canEdit: boolean; onRecord: (itemKey: string, note: string, reference: string) => Promise<{ ok: boolean; errors?: string[] }> }) {
  const ev = line.evidence!;
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-1" data-testid={`evidence-${line.id}`} data-state={ev.state}>
      <span className={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-bold ${ev.state === "recorded" ? "bg-emerald-100 text-emerald-900" : "bg-amber-100 text-amber-950"}`}>{ev.state === "recorded" ? "Evidence recorded" : ev.state === "outdated" ? "Evidence outdated" : "Evidence needed"}</span>
      {canEdit && <button type="button" className="ml-2 min-h-11 text-xs font-semibold text-blue-800 underline" onClick={() => setOpen((o) => !o)} aria-expanded={open}>{ev.state === "recorded" ? "Change evidence" : "Record evidence"}</button>}
      {open && <EvidenceForm line={line} onRecord={onRecord} onDone={() => setOpen(false)} />}
    </div>
  );
}

/** COMPLETED lines and charges: collapsed by default with a clear count; the manual-price reason and evidence stay reachable once opened. */
export function CompleteGroup({ lines, charges, onEdit, canEdit, onRecordEvidence }: { lines: CompleteLine[]; charges: Array<{ label: string; amountExTax: number | null }>; onEdit: (id: string) => void; canEdit: boolean; onRecordEvidence?: (itemKey: string, note: string, reference: string) => Promise<{ ok: boolean; errors?: string[] }> }) {
  const provisionalCount = lines.filter((c) => c.provisional).length;
  const chargesTotal = charges.reduce((a, c) => a + (c.amountExTax ?? 0), 0);
  return (
    <details className="group overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="complete-group">
      <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 px-4 py-2.5 sm:px-5"><h2 id="ws-complete" className="text-base font-bold text-emerald-800">Complete <span className="font-medium text-slate-700" data-testid="complete-count">· {lines.length} line{lines.length === 1 ? "" : "s"} · {charges.length} charge{charges.length === 1 ? "" : "s"}{provisionalCount > 0 && <strong className="text-amber-900" data-testid="complete-provisional"> · {provisionalCount} provisional</strong>}</span></h2><span className="text-xs font-semibold text-blue-800 underline group-open:hidden">Show</span><span className="hidden text-xs font-semibold text-blue-800 underline group-open:inline">Hide</span></summary>
      <div className="overflow-x-auto border-t border-slate-200"><table className="w-full min-w-[480px] text-sm">
        <thead><tr className="text-left text-xs text-slate-700"><th className="px-4 py-2 font-semibold sm:px-5">LINE</th><th className="px-2 py-2 font-semibold">HOW IT WAS RESOLVED</th><th className="px-2 py-2 text-right font-semibold">QTY × UNIT</th><th className="px-4 py-2 text-right font-semibold sm:px-5">EX VAT</th></tr></thead>
        <tbody>
          {lines.map((c) => (
            <tr key={c.id} className="border-t border-slate-200" data-testid={`complete-${c.id}`}>
              <td className="px-4 py-2.5 sm:px-5"><span aria-hidden className="text-emerald-700">✓ </span>{c.label}{c.provisional && <span className="ml-2 rounded bg-amber-800 px-1.5 py-0.5 text-xs font-bold text-white">PROVISIONAL</span>}</td>
              <td className="px-2 py-2.5 text-slate-700">{c.how}{c.manual && <details className="mt-1" data-testid={`manual-detail-${c.id}`}><summary className="cursor-pointer font-semibold text-blue-800">Reason and evidence</summary><dl className="mt-1 text-[13px] text-slate-900"><dt className="font-semibold">Reason</dt><dd className="whitespace-pre-wrap break-words">{c.manual.reason || "—"}</dd><dt className="mt-1 font-semibold">Evidence</dt><dd className="whitespace-pre-wrap break-words">{c.manual.evidence || (c.manual.legacy ? "Not recorded separately (an earlier entry): add it by editing." : "—")}</dd></dl></details>}{!c.estimatorPriced && canEdit && <> · <button type="button" className="font-semibold text-blue-800 underline" onClick={() => onEdit(c.id)}>Edit</button></>}{c.evidence && onRecordEvidence && <EvidenceRecorder line={c} canEdit={canEdit} onRecord={onRecordEvidence} />}</td>
              <td className="whitespace-nowrap px-2 py-2.5 text-right tabular-nums">{c.quantity ?? "—"} × {c.unit == null ? "—" : money(c.unit)}</td>
              <td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums sm:px-5">{c.revenue == null ? "—" : money(c.revenue)}</td>
            </tr>
          ))}
          <tr className="border-t border-slate-200 bg-slate-50"><td className="px-4 py-2.5 text-slate-700 sm:px-5" colSpan={3}>Charges: {charges.map((c) => `${c.label.toLowerCase()} ${c.amountExTax == null ? "not entered" : money(c.amountExTax)}`).join(" · ")}</td><td className="whitespace-nowrap px-4 py-2.5 text-right font-semibold tabular-nums sm:px-5">{money(chargesTotal)}</td></tr>
        </tbody>
      </table></div>
    </details>
  );
}

const Row = ({ label, value, strong, testId }: { label: ReactNode; value: ReactNode; strong?: boolean; testId?: string }) => (
  <div className={`flex items-baseline justify-between gap-3 text-sm ${strong ? "font-semibold" : ""}`}><span className="min-w-0">{label}</span><span className="shrink-0 whitespace-nowrap tabular-nums" data-testid={testId}>{value}</span></div>
);

/** The compact commercial summary: the figures, what was excluded and why, the gap to the Rep's amount, the margin in one line, and what blocks sign-off (at most three). The long explanation is optional help. */
export function SummaryPanel({ s }: { s: Summary }) {
  const partial = s.totalKind === "partial";
  return (
    <aside aria-labelledby="ws-sum" className="flex min-w-0 flex-col gap-2 rounded-xl border border-slate-200 bg-white p-4" data-testid="commercial-summary">
      <h2 id="ws-sum" className="text-base font-bold">Commercial summary</h2>
      <Row label={`Lines with a selling price (${s.pricedLineCount})`} value={money(s.pricedLinesExVat)} />
      <Row label="Charges" value={money(s.chargesExVat)} />
      {s.unpricedLineCount > 0 && <Row label={<span className="font-semibold text-amber-900">No price yet ({s.unpricedLineCount} line{s.unpricedLineCount === 1 ? "" : "s"})</span>} value={<span className="text-amber-900">not in total</span>} />}
      <div className="border-t-2 border-slate-900 pt-2"><Row strong label={partial ? "Partial total, ex VAT" : s.totalKind === "calculated" ? "Calculated total, ex VAT" : "Total, ex VAT"} value={money(s.totalExVat)} testId="summary-total" /></div>
      <Row label={<span className="text-slate-600">VAT 15%{partial ? " on this partial" : ""}</span>} value={<span className="text-slate-600">{money(s.vat)}</span>} />
      <Row label={<span className="text-slate-600">Incl VAT{partial ? ", partial" : ""}</span>} value={<span className="text-slate-600">{money(s.totalIncVat)}</span>} />
      {s.excluded.length > 0 && (
        <div className="rounded-lg border border-amber-600 bg-amber-50 p-2.5 text-[13px] text-amber-950" data-testid="excluded-lines">
          <p className="font-bold">Excluded from this total until costed</p>
          <p className="mt-0.5">These lines were priced on the reference basis when the Rep handed the quotation over. With supplier pricing on they have no price until a supplier cost is entered, so they are not in the total above.</p>
          <ul className="mt-1.5 flex flex-col gap-1">{s.excluded.map((e) => <li key={e.id} className="flex items-baseline justify-between gap-3" data-testid={`excluded-${e.id}`}><span className="min-w-0">{e.label} <span className="text-amber-900">· {e.why}</span></span><span className="shrink-0 whitespace-nowrap tabular-nums">was {money(e.previous)}</span></li>)}</ul>
          <p className="mt-1.5 flex items-baseline justify-between gap-3 border-t border-amber-300 pt-1 font-semibold"><span className="min-w-0">Previously priced, now excluded</span><span className="shrink-0 whitespace-nowrap tabular-nums" data-testid="excluded-total">{money(s.excludedPreviousTotal)}</span></p>
        </div>
      )}
      {s.confirmedCents !== null && (
        <div className="border-t border-slate-200 pt-2" data-testid="summary-confirmed">
          <Row label="Rep confirmed" value={<strong>{money(s.confirmedCents / 100)}</strong>} />
          {s.differenceCents !== null && s.differenceCents !== 0 && <Row label={<span className="text-amber-900">{partial ? "Partial total is" : "Total is"} {s.differenceCents > 0 ? "higher" : "lower"} by</span>} value={<strong className="text-amber-900">{money(Math.abs(s.differenceCents) / 100)}</strong>} />}
        </div>
      )}
      <div className="border-t border-slate-200 pt-2 text-sm" data-testid="summary-margin"><Row label="Margin" value={<span className={s.marginLabel === "indicative" ? "font-semibold text-amber-900" : "text-slate-600"}>{s.marginLabel === "none" ? "none yet" : s.marginLabel === "indicative" ? "indicative, unverified" : "verified"}</span>} /></div>
      {s.blockers.length > 0 && <div className="border-t border-slate-200 pt-2 text-[13px] text-slate-700" data-testid="summary-blockers"><strong className="text-slate-900">Blocking sign-off</strong><ul className="mt-1 list-disc pl-5">{s.blockers.slice(0, 3).map((b) => <li key={b}>{b}</li>)}</ul></div>}
    </aside>
  );
}

/** Optional help: the whole workflow and the four readiness counts. Closed by default so it never lengthens the sidebar. */
export function HowItWorks({ s, step, verified, required }: { s: Summary; step: 1 | 2 | 3 | 4 | 5; verified: number; required: number }): ReactNode {
  const items: Array<[string, string]> = [["You", "price the open tasks. A changed amount goes back to the Rep."], ["Rep", "confirms the new amount with the customer."], ["A Manager", `verifies each supplier cost independently (${verified} of ${required} now). You cannot verify your own entries.`], ["You", "sign off. Locked until the amount is confirmed and costs are verified."], ["A Manager", "approves. No automatic waiver."]];
  const check = (c: { done: number; of: number }) => `${c.done} of ${c.of}`;
  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-1" data-testid="how-it-works">
      <summary className="min-h-11 cursor-pointer py-2.5 text-sm font-semibold text-slate-900">How this works</summary>
      <div className="pb-3 text-sm">
        <ol className="flex flex-col gap-1.5">{items.map(([who, what], i) => <li key={i} aria-current={step === i + 1 ? "step" : undefined} className={step === i + 1 ? "rounded-md bg-sky-50 px-2 py-1 font-semibold" : "px-2 py-1"}><strong>{who}:</strong> <span className="font-normal text-slate-800">{what}</span></li>)}</ol>
        <p className="mt-2 border-t border-slate-200 pt-2 text-xs text-slate-600">Where a price changes, the Rep reconfirms first, then a Manager verifies costs, then you sign off, then a Manager approves.</p>
        <div className="mt-2 border-t border-slate-200 pt-2" data-testid="four-checks"><p className="text-xs font-bold tracking-widest text-slate-600">FOUR SEPARATE CHECKS</p>
          <Row label="Mapping complete" value={check(s.checks.mapping)} /><Row label="Selling price complete" value={check(s.checks.price)} /><Row label="Supplier cost complete" value={check(s.checks.cost)} /><Row label="Independently verified" value={check(s.checks.verified)} /></div>
        <p className="mt-2 text-xs text-slate-600" data-testid="margin-note">{s.marginNote}</p>
      </div>
    </details>
  );
}

export function RepItems({ items }: { items: Array<{ id: string; label: string; why: string }> }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="ws-rep" className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 sm:px-5" data-testid="rep-items">
      <h2 id="ws-rep" className="text-base font-bold text-slate-900">Waiting for the Rep <span className="font-medium text-slate-700">· {items.length}</span></h2>
      <ul className="mt-1 text-sm text-slate-800">{items.map((i) => <li key={i.id} data-testid={`rep-item-${i.id}`}><strong>{i.label}</strong>: {i.why}. These belong to the Rep, so there is no button here.</li>)}</ul>
    </section>
  );
}

/**
 * ONE compact header for the whole screen: which quotation, who for, where it is, the amount (labelled partial/calculated/confirmed, never a contract value while open), the Rep's amount, and how many items need
 * the Estimator. Everything else that used to stack above it (calculation status, submission and confirmation history, the readiness sentence, phase descriptions) is behind the one Details disclosure.
 */
export function WorkspaceHeader({ name, reference, customer, rooms, basis, stageLabel, summary, outstanding, phases, details }: {
  name: string; reference: string; customer: string; rooms: number; basis: string; stageLabel: string; summary: Summary; outstanding: number; phases?: ReactNode; details?: ReactNode;
}) {
  const s = summary;
  return (
    <header className="rounded-xl border border-slate-200 bg-white px-5 py-3" data-testid="workspace-header">
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0 flex-[1_1_16rem]">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1"><h2 className="text-xl font-bold text-slate-900" data-testid="header-name">{name}</h2><span className="rounded border border-amber-600 bg-amber-50 px-2 py-0.5 text-xs font-bold tracking-wide text-amber-900" data-testid="header-stage">{stageLabel}</span></div>
          <p className="mt-0.5 text-sm text-slate-700" data-testid="header-sub"><span data-testid="header-ref">{reference}</span> · {customer} · {rooms} room{rooms === 1 ? "" : "s"} · {basis}</p>
        </div>
        <div className="min-w-0 flex-[0_1_16rem]"><p className={`text-xs font-semibold tracking-wider ${s.totalKind === "confirmed" ? "text-emerald-800" : "text-amber-900"}`} data-testid="header-total-label">{s.totalLabel}</p><p className="text-2xl font-bold tabular-nums" data-testid="header-total">{money(s.totalExVat)}</p><p className="text-xs text-slate-700" data-testid="header-total-note">{s.totalKind === "confirmed" ? "Matches the Rep's amount." : "Not a contract value."}</p></div>
        <div className="min-w-0 flex-[0_1_14rem]"><p className="text-xs font-semibold tracking-wider text-slate-600">REP-CONFIRMED (INDICATIVE)</p><p className="text-lg font-bold tabular-nums" data-testid="header-confirmed">{s.confirmedCents === null ? "none yet" : money(s.confirmedCents / 100)}</p>{s.confirmedCents !== null && <p className="text-xs text-slate-700" data-testid="header-confirmed-note">Not an approved price.</p>}</div>
        <div className="min-w-0 flex-[0_1_8rem]"><p className="text-xs font-semibold tracking-wider text-slate-600">NEEDS YOU</p><p className="text-lg font-bold" data-testid="header-outstanding">{outstanding === 0 ? "Nothing open" : `${outstanding} item${outstanding === 1 ? "" : "s"}`}</p></div>
      </div>
      {(phases || details) && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-slate-100 pt-2">
          {phases}
          {details && <details className="group w-full" data-testid="header-details"><summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-blue-800 underline">Details and history</summary><div className="mt-2 flex flex-col gap-3 text-sm">{details}</div></details>}
        </div>
      )}
    </header>
  );
}
