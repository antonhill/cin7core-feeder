"use client";

import { Button } from "@/components/ui/Button";
import { money, type AutoView, type ReadyLine } from "@/newquip/quote/estimator-workspace";

// The Estimator's automatic-pricing groups (presentational; INTERNAL: it shows supplier costs, rates and freight, so it only ever renders inside the cost-entitled workspace). It decides nothing and does no
// arithmetic: every figure was derived by estimator-workspace.ts from the pricing model's own result. "Ready for verification" and "Pricing exceptions" are the two groups that are not the Estimator's own decisions.

export const AUTO_LABEL = "Automatically priced — awaiting Manager verification";

/** The three counts, one line each. Only genuine outstanding actions are counted as "need confirmation" and "pricing exceptions": an automatically priced product is never a task. */
export function AutoSummary({ auto }: { auto: AutoView }) {
  return (
    <section aria-label="Automatic pricing summary" className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 sm:grid-cols-3 sm:p-4" data-testid="auto-summary">
      <p data-testid="auto-count-priced"><strong className="text-lg text-emerald-900">{auto.autoPriced}</strong> <span className="text-sm text-slate-900">automatically priced — awaiting Manager verification</span></p>
      <p data-testid="auto-count-confirm"><strong className="text-lg text-amber-900">{auto.needConfirmation}</strong> <span className="text-sm text-slate-900">{auto.needConfirmation === 1 ? "needs" : "need"} confirmation</span></p>
      <p data-testid="auto-count-exceptions"><strong className="text-lg text-amber-900">{auto.exceptions.length}</strong> <span className="text-sm text-slate-900">{auto.exceptions.length === 1 ? "pricing exception" : "pricing exceptions"}</span></p>
    </section>
  );
}

/**
 * One automatically priced line: a compact summary that is always visible (what it is, how many, total cost, selling price, status, genuine warnings) and a "View cost details" section that holds the full evidence
 * (every component's Cin7 supplier price, FX, freight and notes). Presentation only: every figure and sentence below was derived by estimator-workspace.ts from the pricing model, none is calculated here, and
 * nothing is removed - only folded. A freight source shared by every component is stated once; a different one is kept beside its own component.
 */
function ReadyLineCard({ l }: { l: ReadyLine }) {
  const n = l.skus.length;
  const sharedFreight = l.freightNotes.length === 1 && l.skus.every((s) => s.freightNote === l.freightNotes[0]) ? l.freightNotes[0] : null;
  return (
    <li className="border-b border-slate-100 px-4 py-2.5 last:border-0 sm:px-5" data-testid={`ready-${l.id}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><strong className="text-[15px]">{l.label}</strong><span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-bold text-emerald-900" data-testid={`ready-status-${l.id}`}>{AUTO_LABEL}</span></div>
      <p className="mt-1 text-[13px] text-slate-900" data-testid={`ready-summary-${l.id}`}>
        Quantity <strong className="tabular-nums">{l.quantity ?? "—"}</strong> · Total cost <strong className="tabular-nums">{l.totalCost != null ? money(l.totalCost) : "—"}</strong> · Selling price <strong className="tabular-nums">{l.revenue != null ? money(l.revenue) : "—"}</strong> ex VAT
        {l.unit != null && <span className="text-slate-700"> ({money(l.unit)} each)</span>} · {n} {n === 1 ? "supplier record" : "component supplier records"}
      </p>
      {l.warnings.length > 0 && (
        <ul className="mt-1 space-y-0.5" data-testid={`ready-warnings-${l.id}`}>
          {l.warnings.map((w) => <li key={w.code} className={`text-[13px] ${w.severity === "critical" ? "font-semibold text-amber-900" : "text-slate-800"}`} data-testid={`ready-warning-${w.code}`}><span aria-hidden>⚠ </span>{w.text}</li>)}
        </ul>
      )}
      <details className="mt-1" data-testid={`ready-details-${l.id}`}>
        <summary className="flex min-h-11 cursor-pointer items-center text-[13px] font-semibold text-indigo-700">View cost details <span className="ml-1 font-normal text-slate-700">· {n} {n === 1 ? "record" : "records"}</span></summary>
        <div className="overflow-x-auto"><table className="mt-1 w-full min-w-[44rem] text-[13px]"><thead><tr className="text-left text-xs text-slate-700"><th className="py-1 pr-2">SKU</th><th className="px-2 text-right">QTY</th><th className="px-2">CIN7 SUPPLIER</th><th className="px-2">COST</th><th className="px-2">DATE</th><th className="px-2">FX</th><th className="px-2">FREIGHT</th><th className="px-2 text-right">LANDED / UNIT</th><th className="px-2 text-right">SELLING / UNIT</th></tr></thead>
          <tbody>{l.skus.map((s) => (
            <tr key={s.sku} className="border-t border-slate-100 align-top" data-testid={`ready-sku-${s.sku}`}>
              <td className="py-1 pr-2 font-semibold">{s.sku}</td><td className="px-2 text-right tabular-nums">{s.quantity ?? "—"}</td><td className="px-2">{s.supplier ?? "—"}</td><td className="px-2 tabular-nums">{s.cost ?? "—"}</td><td className="px-2 tabular-nums">{s.costDate ?? "—"}</td>
              <td className="px-2 tabular-nums">{s.fx ?? "—"}</td><td className="px-2 tabular-nums">{s.freight ?? "—"}</td><td className="px-2 text-right tabular-nums">{s.landed ?? "—"}</td><td className="px-2 text-right tabular-nums">{s.selling ?? "—"}</td>
            </tr>
          ))}</tbody></table></div>
        {sharedFreight && <p className="mt-1 text-xs text-slate-700" data-testid={`ready-freight-${l.id}`}>All {n} {n === 1 ? "component" : "components"}: {sharedFreight}</p>}
        {l.skus.map((s) => { const parts = [s.costNote, s.fxNote, sharedFreight ? null : s.freightNote].filter(Boolean).join(" "); return parts ? <p key={s.sku} className="mt-1 text-xs text-slate-700">{s.sku}: {parts}</p> : null; })}
      </details>
    </li>
  );
}

/** Products priced entirely from automatic Cin7 costs: a compact line each (see ReadyLineCard); the evidence behind each opens in place. */
export function ReadyForVerification({ auto }: { auto: AutoView }) {
  if (auto.ready.length === 0) return null;
  const critical = auto.ready.filter((l) => l.warnings.some((w) => w.severity === "critical")).length;
  return (
    <section aria-labelledby="ws-ready" className="overflow-hidden rounded-xl border border-slate-200 bg-white" data-testid="auto-ready">
      <div className="border-b border-slate-200 px-4 py-2.5 sm:px-5"><h2 id="ws-ready" className="text-base font-bold">Ready for verification <span className="text-emerald-900">· {auto.ready.length} line{auto.ready.length === 1 ? "" : "s"}</span></h2><p className="text-[13px] text-slate-800">{AUTO_LABEL}. A Manager checks each cost independently; you do not re-enter these. Open “View cost details” on a line for the supplier prices, exchange rates, freight and notes behind it.</p>
        {critical > 0 && <p className="mt-1 text-[13px] font-semibold text-amber-900" data-testid="auto-ready-critical">⚠ {critical} {critical === 1 ? "line carries" : "lines carry"} a warning shown below.</p>}
      </div>
      <ul>{auto.ready.map((l) => <ReadyLineCard key={l.id} l={l} />)}</ul>
    </section>
  );
}

/** Products with NO automatic price: the specific stored reason, the corrective action and the one button that opens it. "Price from Cin7" appears only where reading Cin7 again may help. */
export function PricingExceptions({ auto, canEdit, busy, onOpen, onPrice }: { auto: AutoView; canEdit: boolean; busy: boolean; onOpen: (taskId: string) => void; onPrice: () => void }) {
  if (auto.exceptions.length === 0) return null;
  return (
    <section aria-labelledby="ws-exceptions" className="overflow-hidden rounded-xl border border-amber-300 bg-white" data-testid="auto-exceptions">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-200 bg-amber-50 px-4 py-2.5 sm:px-5">
        <h2 id="ws-exceptions" className="text-base font-bold">Pricing exceptions <span className="text-amber-900">· {auto.exceptions.length} product{auto.exceptions.length === 1 ? "" : "s"}</span></h2>
        {auto.canPrice && auto.retryable > 0 && <Button type="button" className="min-h-11" data-testid="price-from-cin7" loading={busy} disabled={busy || !canEdit} onClick={onPrice}>Price {auto.retryable} from Cin7</Button>}
        {auto.unavailableReason && <Button type="button" className="min-h-11" data-testid="price-from-cin7-disabled" disabled aria-describedby="price-from-cin7-why">Price from Cin7 unavailable</Button>}
      </div>
      {auto.unavailableReason && <p id="price-from-cin7-why" role="note" className="border-b border-amber-200 bg-amber-50/60 px-4 py-2 text-[13px] text-slate-900 sm:px-5" data-testid="price-from-cin7-why">Why: {auto.unavailableReason}</p>}
      <ul>
        {auto.exceptions.map((e) => (
          <li key={e.sku} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-slate-100 px-4 py-2.5 last:border-0 sm:px-5" data-testid={`exception-${e.sku}`}>
            <div className="min-w-0 flex-[1_1_16rem]">
              <p><strong className="text-[15px]">{e.sku}</strong> <span className="text-sm text-slate-700">{e.usedBy.join(", ")}</span></p>
              <p className="mt-0.5 text-[13px] text-slate-900" data-testid={`exception-reason-${e.sku}`}>{e.reason}</p>
              <p className="text-[13px] text-slate-700" data-testid={`exception-action-${e.sku}`}>What to do: {e.action}</p>
            </div>
            <Button type="button" variant="secondary" className="min-h-11 w-full sm:w-[150px]" disabled={!canEdit} onClick={() => onOpen(e.taskId)} aria-label={`Open ${e.sku}`}>Open</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
