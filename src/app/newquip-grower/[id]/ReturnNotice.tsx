import { formatSast } from "@/lib/approvals/time";
import type { ReturnInfo } from "@/newquip/quote/return-info";

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
