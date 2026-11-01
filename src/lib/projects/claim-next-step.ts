// The ONE plain-language "what happens next" line shown on a claim card (UAT-015). Pure and display-only: it never decides or authorises anything.
import type { ClaimCin7Kind } from "./claim-cin7-status";

/** `canApproveHere` = the viewer has the direct Approve button; `canAct` = the viewer can change claims at all. Wording never promises an action the viewer does not have. */
export function claimNextStep(c: { status: string; cin7Kind: ClaimCin7Kind; stageRole?: string | null; canApproveHere?: boolean; canAct?: boolean }): string {
  switch (c.status) {
    case "DRAFT": return c.canAct === false ? "A draft: waiting for someone with edit access to submit it." : "Submit it for approval, or recalculate / cancel the draft.";
    case "READY_FOR_APPROVAL": return c.canApproveHere ? "Submitted. You can approve it here, or open it in Approvals." : `Waiting for ${c.stageRole ? c.stageRole.toLowerCase() : "an approver"} to approve in Approvals.`;
    case "CANCELLED_BEFORE_WRITE": return "Closed: nothing was sent to Cin7 and no value is reserved.";
    case "FAILED_CONFIRMED_NO_WRITE": return "Closed: Cin7 confirmed nothing was created.";
    case "FAILED_UNCERTAIN": return "Reconcile with Cin7 before doing anything else with this claim.";
    default: break;
  }
  // Approved or later: the Cin7 posting decides the next step.
  switch (c.cin7Kind) {
    case "NOT_POSTED": return "Approved. A manager (owner/admin) can now post it to Cin7 as a draft invoice.";
    case "POSTING": return "Posting to Cin7 is in progress. Do not retry; refresh to see the outcome.";
    case "DRAFT_CREATED": return "Draft invoice created in Cin7. Review and authorise it in Cin7.";
    case "AUTHORISED": return "Invoice authorised in Cin7. Nothing further to do here.";
    case "CREATED_OTHER": return "Invoice created in Cin7. Check its status there.";
    case "FAILED": return "Posting failed and nothing was created. A manager can review and retry.";
    case "UNCERTAIN": return "Cin7's result is uncertain. Reconcile before any retry.";
  }
}
