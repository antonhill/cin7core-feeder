import { formatSast } from "@/lib/approvals/time";
import type { ReturnInfo } from "@/newquip/quote/return-info";
import type { ChangeKind, RepLineChange, RepRevisionChanges } from "@/newquip/quote/rep-revision-changes";

// D5 UI: WHY THE QUOTATION IS BACK. Presentation only: the server (QuoteView.returnInfo) decided what this viewer may see; a Rep gets a neutral line for a return TO the Estimator.

/** The lines to show for a return, pure. `fmt` formats cents (the page's fmtCents). */
export function returnNoticeText(info: ReturnInfo, fmt: (cents: number) => string): { headline: string; detail: string; action: string | null } {
  const who = info.byEmail ? `${info.byEmail}${info.byRole ? ` (${info.byRole})` : ""}` : null;
  if (info.destination === "ESTIMATOR") {
    return who
      ? { headline: "Returned to the Estimator", detail: `Returned by ${who} on ${formatSast(info.at)}: “${info.reason}”`, action: "Review it again and sign off, or return it to the Rep." }
      : { headline: "With the Estimator for review.", detail: "", action: null };
  }
  if (info.kind === "AMOUNT_CHANGED" && info.previousCents != null && info.newCents != null) {
    return { headline: "Returned to the Rep", detail: `The total changed from ${fmt(info.previousCents)} to ${fmt(info.newCents)}; the customer’s confirmation was withdrawn. Reconfirm the new amount with the customer and submit again (step 5).`, action: null };
  }
  if (info.kind !== "RETURN") return { headline: "Returned to the Rep", detail: info.reason, action: "Reconfirm with the customer, then submit again." };
  return { headline: "Returned to the Rep", detail: `Returned by ${who ?? "the Estimator/Manager"} on ${formatSast(info.at)}: “${info.reason}”`, action: "Fix what the Estimator described, then submit again." };
}

/**
 * Estimator / Manager view of a Manager return to the Estimator. ONE line (the reason is truncated, the full text opens in place), so the step's first control stays above the fold; the
 * headline, the reason and the action keep their text and test ids.
 */
export function EstimatorReturnNotice({ info, fmt, onOpenReview }: { info: ReturnInfo | null; fmt: (cents: number) => string; /** D-21: shown on any stage OTHER than the Estimator review (where they may land): a pointer to it. */ onOpenReview?: () => void }) {
  if (!info || info.destination !== "ESTIMATOR") return null;
  const t = returnNoticeText(info, fmt);
  return (
    <details className="group mt-2 rounded-lg border border-amber-300 bg-amber-50 px-3 text-sm text-amber-950" data-testid="estimator-return-notice">
      <summary className="flex min-h-11 cursor-pointer items-center gap-x-2 py-1 group-open:items-start">
        <span className="shrink-0 font-semibold">{t.headline}</span>
        {t.detail && <span className="min-w-0 flex-1 truncate group-open:overflow-visible group-open:whitespace-normal" data-testid="estimator-return-reason">{t.detail}</span>}
        <span className="shrink-0 text-xs font-semibold text-indigo-700">Details</span>
      </summary>
      {t.action && <p className="pb-2">{t.action}</p>}
      {onOpenReview && <p className="pb-2"><button type="button" className="inline-flex min-h-11 items-center font-semibold text-indigo-700 underline" onClick={onOpenReview} data-testid="estimator-return-open-review">Open the Estimator review (Stage 2)</button></p>}
    </details>
  );
}

// ── Rep revision comparison ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Presentation only. The server (QuoteView.repChanges) built every value from customer-safe fields (labels, quantities, selling prices, totals); nothing here can show a cost because none arrives.

const sgn = (c: number, fmt: (cents: number) => string) => `${c > 0 ? "+" : c < 0 ? "−" : ""}${fmt(Math.abs(c))}`;
const KIND_LABEL: Record<ChangeKind, string> = { added: "Added", removed: "Removed", changed: "Changed", unchanged: "Unchanged" };
const KIND_STYLE: Record<ChangeKind, string> = { added: "bg-emerald-100 text-emerald-950", removed: "bg-rose-100 text-rose-950", changed: "bg-amber-100 text-amber-950", unchanged: "bg-slate-100 text-slate-800" };

/** The one-line summary the banner shows without opening anything (pure, for tests). */
export function repChangesSummary(c: RepRevisionChanges, fmt: (cents: number) => string): string {
  if (!c.available) return c.before && c.after && c.deltaExVatCents != null ? `Total ex VAT ${fmt(c.before.subtotalExVatCents)} → ${fmt(c.after.subtotalExVatCents)} (${sgn(c.deltaExVatCents, fmt)})` : "Itemised changes are not available for this revision.";
  if (!c.anyChange) return "No customer-facing quotation changes detected";
  const n = c.counts; const parts = [n.added && `${n.added} added`, n.removed && `${n.removed} removed`, n.changed && `${n.changed} changed`, n.charges && `${n.charges} ${n.charges === 1 ? "charge" : "charges"} changed`].filter(Boolean);
  const pct = c.deltaPercent == null ? "" : ` / ${c.deltaPercent > 0 ? "+" : c.deltaPercent < 0 ? "−" : ""}${Math.abs(c.deltaPercent)}%`;
  return `${parts.join(", ") || "Total changed"} · Total ex VAT ${fmt(c.before!.subtotalExVatCents)} → ${fmt(c.after!.subtotalExVatCents)} (${sgn(c.deltaExVatCents ?? 0, fmt)}${pct})`;
}

/** One side of a line, compact: the selling line total first, then quantity and how it was priced. A package total is labelled as such; a unit price is shown only where one is recorded. */
function Side({ v, fmt }: { v: RepLineChange["before"]; fmt: (cents: number) => string }) {
  if (!v) return <span className="text-slate-600">—</span>;
  if (v.basis === "none") return <span className="text-slate-700" data-basis="none">Not priced{v.quantity != null ? <span className="block text-xs">Qty {v.quantity}</span> : null}</span>;
  return (
    <span data-basis={v.basis}>
      <strong className="tabular-nums">{fmt(v.lineTotalCents!)}</strong>
      <span className="block text-xs text-slate-800">Qty {v.quantity ?? "—"} · {v.basis === "unit" ? `Unit ${fmt(v.unitPriceCents!)}` : "Package total (unit price not separately recorded)"}</span>
    </span>
  );
}

const changeNote = (l: RepLineChange, fmt: (cents: number) => string): string => {
  if (l.kind === "added") return "New line";
  if (l.kind === "removed") return "Line removed";
  if (l.kind === "unchanged") return "No change";
  if (l.before?.basis === "none" && l.after?.basis !== "none") return "Now priced";
  if (l.after?.basis === "none" && l.before?.basis !== "none") return "No longer priced";
  return l.fields.filter((f) => f !== "Selling line total").join(" · ") || (l.deltaCents != null ? `Total ${sgn(l.deltaCents, fmt)}` : "Changed");
};

function LineRow({ l, fmt }: { l: RepLineChange; fmt: (cents: number) => string }) {
  return (
    <li className="grid gap-x-3 gap-y-1 border-t border-amber-200 py-2 text-[13px] sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)]" data-testid={`change-line-${l.key}`} data-kind={l.kind}>
      <p className="font-semibold">{(l.after ?? l.before)!.label}</p>
      <p><span className="text-xs font-semibold text-slate-700 sm:hidden">Previous: </span><span className="sm:block"><Side v={l.before} fmt={fmt} /></span></p>
      <p><span className="text-xs font-semibold text-slate-700 sm:hidden">Revised: </span><span className="sm:block"><Side v={l.after} fmt={fmt} /></span></p>
      <p><span className={`rounded px-2 py-0.5 text-xs font-bold ${KIND_STYLE[l.kind]}`}>{KIND_LABEL[l.kind]}</span> <span className="text-xs text-slate-800">{changeNote(l, fmt)}</span>{l.deltaCents != null && l.deltaCents !== 0 && <span className="block text-xs font-semibold tabular-nums">{sgn(l.deltaCents, fmt)} ex VAT</span>}</p>
    </li>
  );
}

const LinesHeader = () => (
  <div className="hidden gap-x-3 border-b border-amber-300 pb-1 text-xs font-bold text-slate-800 sm:grid sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,0.9fr)]" aria-hidden="true"><span>Equipment</span><span>Previous</span><span>Revised</span><span>Change</span></div>
);

/**
 * VIEW CHANGES (Rep). A compact summary that is always visible, and one expandable itemised comparison under it: changed lines first, unchanged lines folded. `revision` is the revision now being
 * reconfirmed; the panel names both revisions so it can never pass for a different pair.
 */
export function RepChangesPanel({ changes, fmt, reason }: { changes: RepRevisionChanges | null | undefined; fmt: (cents: number) => string; /** The Estimator's / Manager's written reason, shown once with the comparison. */ reason?: string | null }) {
  if (!changes) return null;
  const c = changes;
  const changed = c.lines.filter((l) => l.kind !== "unchanged"); const same = c.lines.filter((l) => l.kind === "unchanged");
  const chargeChanges = c.charges.filter((x) => x.kind !== "unchanged");
  return (
    <div className="mt-3 rounded-lg border border-amber-400 bg-white p-3 text-sm text-slate-950" data-testid="rep-changes">
      <p className="font-semibold" data-testid="rep-changes-summary">{repChangesSummary(c, fmt)}</p>
      {c.available && c.before && c.after && (
        <p className="mt-1 text-[13px] text-slate-800" data-testid="rep-changes-basis">Revision {c.basis.previousRevision} (as you confirmed it{c.basis.previousCapturedAt ? ` on ${formatSast(c.basis.previousCapturedAt)}` : ""}) compared with the current revision {c.basis.currentRevision}. Includes any edit you have made since it came back.</p>
      )}
      {!c.available && <p className="mt-1 text-[13px] text-slate-800" data-testid="rep-changes-unavailable">{c.unavailableReason === "NOT_PRICED" ? "There is no priced quotation to compare yet." : "The itemised comparison is not available for this revision: the quotation you confirmed was not recorded line by line. The totals above are all that can be compared reliably."}</p>}
      {c.available && (
        <details className="mt-2" data-testid="rep-changes-details">
          <summary className="inline-flex min-h-11 cursor-pointer items-center rounded-lg bg-indigo-700 px-4 text-sm font-semibold text-white" data-testid="view-changes">View Changes</summary>
          {!c.anyChange ? <p className="mt-2 font-medium" data-testid="rep-changes-none">No customer-facing quotation changes detected</p> : (
            <div className="mt-2">
              {reason && <p className="text-[13px]" data-testid="rep-changes-reason"><span className="font-semibold">Reason given: </span>{reason}</p>}
              <dl className="mt-2 grid gap-1 text-[13px] sm:grid-cols-2" data-testid="rep-changes-totals">
                <div><dt className="text-xs font-semibold text-slate-700">Previous total</dt><dd className="tabular-nums">{fmt(c.before!.subtotalExVatCents)} ex VAT · {fmt(c.before!.totalIncVatCents)} incl. VAT</dd></div>
                <div><dt className="text-xs font-semibold text-slate-700">Revised total</dt><dd className="tabular-nums">{fmt(c.after!.subtotalExVatCents)} ex VAT · {fmt(c.after!.totalIncVatCents)} incl. VAT</dd></div>
                <div className="sm:col-span-2"><dt className="text-xs font-semibold text-slate-700">Difference</dt><dd className="font-semibold tabular-nums">{sgn(c.deltaExVatCents ?? 0, fmt)} ex VAT{c.deltaPercent != null ? ` (${c.deltaPercent > 0 ? "+" : c.deltaPercent < 0 ? "−" : ""}${Math.abs(c.deltaPercent)}%)` : ""}</dd></div>
              </dl>
              {changed.length > 0 && <div className="mt-2"><LinesHeader /><ul data-testid="rep-changes-lines">{changed.map((l) => <LineRow key={l.key} l={l} fmt={fmt} />)}</ul></div>}
              {chargeChanges.length > 0 && (
                <ul className="mt-2" data-testid="rep-changes-charges">
                  {chargeChanges.map((x) => (
                    <li key={x.key} className="flex flex-wrap items-center gap-2 border-t border-amber-200 py-2 text-[13px]" data-testid={`change-charge-${x.key}`} data-kind={x.kind}>
                      <span className={`rounded px-2 py-0.5 text-xs font-bold ${KIND_STYLE[x.kind]}`}>{KIND_LABEL[x.kind]}</span><strong>{x.label}</strong>
                      <span className="tabular-nums">{x.beforeCents == null ? "not entered" : fmt(x.beforeCents)} → {x.afterCents == null ? "not entered" : fmt(x.afterCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {same.length > 0 && (
                <details className="mt-2 border-t border-amber-200 pt-2" data-testid="rep-changes-unchanged">
                  <summary className="min-h-11 cursor-pointer py-2 text-[13px] font-semibold text-indigo-800">{same.length} unchanged {same.length === 1 ? "line" : "lines"}</summary>
                  <ul>{same.map((l) => <LineRow key={l.key} l={l} fmt={fmt} />)}</ul>
                </details>
              )}
              <p className="mt-2 text-[13px] font-medium" data-testid="rep-changes-review">Before you reconfirm: check the revised amount ({fmt(c.after!.subtotalExVatCents)} ex VAT) with the customer.</p>
            </div>
          )}
        </details>
      )}
    </div>
  );
}
