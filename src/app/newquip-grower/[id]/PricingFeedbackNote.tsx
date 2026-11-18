"use client";

import { Status } from "@/components/ui/Status";
import type { PricingFeedback } from "@/newquip/pricing/pricing-feedback";

// NQ-008A. The Rep's answer to "is this price final, and how complete is it?". Presentation only: everything comes from the server's `pricingFeedback` (already
// phrased for the viewer), so no cost basis can appear here. The price is ALWAYS indicative until the Manager approves it; the chip says how complete it is.

const TONE = { complete: "success", provisional: "warning", not_priced: "neutral" } as const;

export function PricingFeedbackNote({ feedback }: { feedback: PricingFeedback }) {
  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm" data-testid="pricing-feedback" data-completeness={feedback.completeness}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Status tone={TONE[feedback.completeness]}>{feedback.label}</Status>
        <span className="text-slate-800" data-testid="pricing-feedback-detail">{feedback.detail}</span>
      </div>
      {feedback.reasons.length > 0 && (
        <details className="mt-1" data-testid="pricing-feedback-reasons">
          <summary className="min-h-11 cursor-pointer py-2 text-xs font-semibold text-slate-800">What is still outstanding ({feedback.reasons.length + feedback.moreReasons})</summary>
          <ul className="list-disc space-y-0.5 pl-5 text-slate-800">
            {feedback.reasons.map((r) => <li key={r}>{r}</li>)}
            {feedback.moreReasons > 0 && <li>and {feedback.moreReasons} more</li>}
          </ul>
        </details>
      )}
    </div>
  );
}
