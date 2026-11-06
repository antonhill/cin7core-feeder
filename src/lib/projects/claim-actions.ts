// Which claim actions the Projects screen OFFERS for a claim in a given state to a viewer. Display only: every action is still authorised on
// the server. A submitted (READY_FOR_APPROVAL) claim is decided in the Approvals dashboard, and its amount cannot be recalculated in place.

export type ViewerTier = "admin" | "member" | "none";
export interface ClaimActionPlan {
  submit: boolean;
  recalculate: boolean;
  /** Direct approve in Projects: org owner/admin only (the legacy tier path). Everyone else decides in Approvals. */
  approveHere: boolean;
  cancel: boolean;
  cancelLabel: string;
  /** Link to the Approvals dashboard request, when there is one. */
  openInApprovals: boolean;
  /** Text shown in place of the buttons when the viewer cannot act here. */
  waitingText: string | null;
}

export function claimActionPlan(c: { status: string; approval: { requestId: string; stageRole: string | null } | null }, tier: ViewerTier): ClaimActionPlan {
  const canWrite = tier !== "none";
  const draft = c.status === "DRAFT";
  const submitted = c.status === "READY_FOR_APPROVAL";
  const stage = c.approval?.stageRole ? c.approval.stageRole.toLowerCase() : null;
  return {
    submit: draft && canWrite,
    recalculate: draft && canWrite,
    approveHere: submitted && tier === "admin",
    cancel: (draft || submitted) && canWrite,
    cancelLabel: submitted ? "Withdraw claim" : "Cancel",
    openInApprovals: submitted && !!c.approval,
    waitingText: submitted && tier !== "admin"
      ? c.approval
        ? `Awaiting ${stage ?? "approver"} approval in Approvals (needs the ${stage ?? "approver"} role; the preparer cannot approve their own claim)`
        : "Submitted. No approval request was found: ask an owner/admin to check Approvals."
      : null,
  };
}
