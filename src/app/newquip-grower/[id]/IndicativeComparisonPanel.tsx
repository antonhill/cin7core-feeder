"use client";

import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { formatSast } from "@/lib/approvals/time";
import { COMPLETENESS_LABEL } from "@/newquip/pricing/pricing-feedback";
import type { ComparisonRow, ComparisonSide, IndicativeComparison } from "@/newquip/pricing/comparison";
import { fmtCents } from "../fields";

// NQ-008A. The Estimator's view of "what the Rep handed off" against "now": the original indicative total, the current total, the difference, and for every line that
// moved - what it was, what it is, why, and who last changed it. Read-only; every figure is computed on the server from the immutable snapshot. A line that is not
// priced reads "Not priced", never R0. Rendered only for viewers with cost visibility.

const money = (c: number | null | undefined): string => (c == null ? "Not priced" : fmtCents(c));
const signed = (c: number): string => (c === 0 ? fmtCents(0) : `${c > 0 ? "+" : "-"}${fmtCents(Math.abs(c))}`);
const side = (s: ComparisonSide | null): string => (s == null ? "Not on the quote" : s.revenueCents == null ? `Not priced (${s.status.replace(/_/g, " ")})` : `${s.quantity ?? ""} x ${fmtCents(Math.round((s.unitPriceExVat ?? 0) * 100))} = ${fmtCents(s.revenueCents)}`);

function Row({ r }: { r: ComparisonRow }) {
  return (
    <li className="rounded-md border border-slate-200 p-3" data-testid="comparison-row" data-key={r.key}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4">
        <span className="font-semibold text-slate-900">{r.label}</span>
        <span className={`tabular-nums font-semibold ${r.deltaCents === 0 ? "text-slate-700" : "text-slate-900"}`} data-testid="row-delta">{signed(r.deltaCents)}</span>
      </div>
      <dl className="mt-1 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="text-xs text-slate-700">Indicative at handoff</dt><dd className="tabular-nums text-slate-900" data-testid="row-original">{side(r.original)}</dd></div>
        <div><dt className="text-xs text-slate-700">Now</dt><dd className="tabular-nums text-slate-900" data-testid="row-current">{side(r.current)}</dd></div>
      </dl>
      <p className="mt-1 text-sm text-slate-800" data-testid="row-reason"><span className="text-xs text-slate-700">Why: </span>{r.reasons.join(" · ")}</p>
      <p className="text-sm text-slate-800" data-testid="row-attribution">
        <span className="text-xs text-slate-700">Changed by: </span>
        {r.changes.length > 0 ? r.changes.map((c) => `${c.by}, ${formatSast(c.at)}`).join("; ") : "Not attributed (no recorded edit: the figure moved for another reason, such as a price-source change)"}
      </p>
    </li>
  );
}

export function IndicativeComparisonPanel({ c }: { c: IndicativeComparison }) {
  const changed = c.rows.filter((r) => r.changed);
  return (
    <Panel className="mt-3">
      <PanelTitle>Indicative price versus current price</PanelTitle>
      {c.basis !== "snapshot" ? (
        <div className="mt-2 text-sm text-slate-800" data-testid="comparison-unavailable">
          <p>{c.note}</p>
          {c.originalTotalCents != null && (
            <p className="mt-1 tabular-nums">Customer-confirmed amount {fmtCents(c.originalTotalCents)} · current {money(c.currentTotalCents)}{c.deltaCents != null && <> · difference <b>{signed(c.deltaCents)}</b></>}</p>
          )}
        </div>
      ) : (
        <>
          <dl className="mt-3 grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2 xl:grid-cols-4" data-testid="comparison-summary">
            <div><dt className="text-xs text-slate-700">Indicative at handoff (ex VAT)</dt><dd className="font-semibold tabular-nums text-slate-900" data-testid="cmp-original">{money(c.originalTotalCents)}</dd><dd className="text-xs text-slate-700">{c.originalCompleteness ? COMPLETENESS_LABEL[c.originalCompleteness] : ""}{c.capturedBy ? ` · ${c.capturedBy}` : ""}{c.capturedAt ? `, ${formatSast(c.capturedAt)}` : ""}</dd></div>
            <div><dt className="text-xs text-slate-700">Current (ex VAT)</dt><dd className="font-semibold tabular-nums text-slate-900" data-testid="cmp-current">{money(c.currentTotalCents)}</dd><dd className="text-xs text-slate-700">{COMPLETENESS_LABEL[c.currentCompleteness]}</dd></div>
            <div><dt className="text-xs text-slate-700">Difference</dt><dd className="font-semibold tabular-nums text-slate-900" data-testid="cmp-delta">{c.deltaCents == null ? "Not available" : signed(c.deltaCents)}</dd></div>
            <div><dt className="text-xs text-slate-700">Lines changed</dt><dd className="font-semibold tabular-nums text-slate-900" data-testid="cmp-changed-count">{changed.length}</dd></div>
          </dl>
          {c.basisChanges.length > 0 && <div className="mt-2" data-testid="cmp-basis-changes">{c.basisChanges.map((b) => <p key={b}><Status tone="warning">{b}</Status></p>)}</div>}
          {changed.length === 0
            ? <p className="mt-3 text-sm text-slate-800" data-testid="cmp-unchanged">Nothing has changed since the Rep handed this quotation off.</p>
            : <ul className="mt-3 space-y-2" data-testid="comparison-rows">{changed.map((r) => <Row key={r.key} r={r} />)}</ul>}
          {c.history.length > 1 && (
            <details className="mt-3" data-testid="cmp-history">
              <summary className="min-h-11 cursor-pointer py-2 text-xs font-semibold text-slate-800">Earlier handoffs ({c.history.length - 1})</summary>
              <ul className="space-y-1 text-sm tabular-nums text-slate-800">
                {c.history.slice(0, -1).map((h) => <li key={h.seq}>Handoff {h.seq} (revision {h.revision}): {fmtCents(h.totalCents)} · {COMPLETENESS_LABEL[h.completeness]} · {h.capturedBy}, {formatSast(h.capturedAt)}</li>)}
              </ul>
            </details>
          )}
        </>
      )}
    </Panel>
  );
}
