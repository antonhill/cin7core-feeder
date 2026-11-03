import type { StageView } from "./stages";

// SOLUTION BUILDER STAGE 5 STATUS BANNER (pure). Stage 5 is not a stepper: the customer's response is one status. The banner restates the EXISTING stage-5 status (computeStages)
// as a headline and the single next action; it reads no new data and decides nothing.

export type AcceptanceTone = "info" | "success" | "warning" | "danger";
export interface AcceptanceBanner { headline: string; tone: AcceptanceTone; body: string; next: string | null }

export function deriveAcceptanceBanner(stage5: StageView, commercial: string | null): AcceptanceBanner | null {
  switch (stage5.status) {
    case "LOADING": case "NOT_AVAILABLE": return null; // the existing loading / information messages stand
    case "NOT_REQUIRED": return { headline: "Not required (grandfathered)", tone: "info", body: stage5.summary, next: null };
    case "COMPLETE": return { headline: "Accepted", tone: "success", body: stage5.summary, next: null };
    case "RETURNED": return { headline: `Returned: ${commercial === "CUSTOMER_DECLINED" ? "declined" : commercial === "CHANGES_REQUESTED" ? "changes requested" : "acceptance rejected"}`, tone: "danger", body: stage5.summary, next: stage5.next };
    case "AWAITING_ACTION": return commercial === "ACCEPTANCE_PENDING_VERIFICATION"
      ? { headline: "Pending verification", tone: "warning", body: stage5.summary, next: stage5.next }
      : { headline: "Awaiting customer response", tone: "info", body: stage5.summary, next: stage5.next };
    default: return { headline: "Awaiting the quotation to be sent", tone: "info", body: stage5.summary, next: null };
  }
}
