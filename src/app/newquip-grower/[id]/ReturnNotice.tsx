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
    return { headline: "Returned to the Rep", detail: `The total changed from ${fmt(info.previousCents)} to ${fmt(info.newCents)}; the customer’s confirmation was withdrawn: reconfirm the new amount with the customer and submit again.`, action: null };
  }
  if (info.kind !== "RETURN") return { headline: "Returned to the Rep", detail: info.reason, action: "Reconfirm with the customer, then submit again." };
  return { headline: "Returned to the Rep", detail: `Returned by ${who ?? "the Estimator/Manager"} on ${formatSast(info.at)}: “${info.reason}”`, action: "Fix what the Estimator described, then submit again." };
}

/** Estimator / Manager view of a Manager return to the Estimator. */
export function EstimatorReturnNotice({ info, fmt }: { info: ReturnInfo | null; fmt: (cents: number) => string }) {
  if (!info || info.destination !== "ESTIMATOR") return null;
  const t = returnNoticeText(info, fmt);
  return (
    <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" role="status" data-testid="estimator-return-notice">
      <p className="font-semibold">{t.headline}</p>
      {t.detail && <p className="mt-1" data-testid="estimator-return-reason">{t.detail}</p>}
      {t.action && <p className="mt-1">{t.action}</p>}
    </div>
  );
}
