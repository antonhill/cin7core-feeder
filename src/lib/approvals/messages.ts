// Notification content (pure). Plain text: no editable token, credential or internal identifier other than the request's own page link, which still
// requires login and server-side authorisation. Times are always SAST.
import { DOC_TYPE_LABEL, type ApprovalRequestRow } from "./types";
import { formatSast } from "./time";
import { safeReason } from "./email-policy";

export type NotificationKind = "ESTIMATOR_ASSIGNED" | "MANAGER_SUBMITTED" | "RETURNED_TO_ESTIMATOR" | "RETURNED_TO_REP" | "SUBMITTED" | "REASSIGNED" | "REASSIGNED_AWAY" | "APPROVED" | "RETURNED" | "REJECTED" | "RESUBMITTED" | "OVERDUE" | "ESCALATED";
export interface NotificationSpec { kind: string; recipient: string; subject: string; body: string }
const rand = (c: number) => `R ${(c / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const ACTION: Record<NotificationKind, string> = {
  ESTIMATOR_ASSIGNED: "Review the scope, quantities, costs and margin, then sign it off or return it to the salesperson.",
  MANAGER_SUBMITTED: "The estimator signed this off: review and approve it, return it to the estimator, or reject it.",
  RETURNED_TO_ESTIMATOR: "The manager returned this to you: correct the estimate, then sign it off again (or return it to the salesperson).",
  RETURNED_TO_REP: "Make the requested changes and resubmit it.",
  SUBMITTED: "Review and approve, return or reject it.", RESUBMITTED: "A revised version was submitted: review and approve, return or reject it.",
  REASSIGNED: "It is now assigned to you: review and approve, return or reject it.", REASSIGNED_AWAY: "No action is needed from you; it was reassigned.",
  APPROVED: "No action needed. The approval does not create anything in Cin7.", RETURNED: "Make the requested changes and resubmit.", REJECTED: "No further approval is possible for this revision; see the reason.",
  OVERDUE: "This approval is past its target date: please decide.", ESCALATED: "This approval is overdue and was escalated to you.",
};
const HEADLINE: Record<NotificationKind, string> = {
  ESTIMATOR_ASSIGNED: "assigned to you for estimator review", MANAGER_SUBMITTED: "submitted for manager approval", RETURNED_TO_ESTIMATOR: "returned to the estimator", RETURNED_TO_REP: "returned to the salesperson",
  SUBMITTED: "submitted for approval", RESUBMITTED: "resubmitted for approval", REASSIGNED: "reassigned to you for approval", REASSIGNED_AWAY: "reassigned to another approver", APPROVED: "approved",
  RETURNED: "returned for changes", REJECTED: "rejected", OVERDUE: "approval overdue", ESCALATED: "approval overdue (escalated)",
};

export function buildNotification(kind: NotificationKind, req: ApprovalRequestRow, to: string, opts: { baseUrl?: string; reason?: string | null; by?: string | null; kindKey?: string; newApprover?: string | null; anyOf?: string | null } = {}): NotificationSpec {
  const label = DOC_TYPE_LABEL[req.doc_type];
  const link = `${(opts.baseUrl ?? "").replace(/\/$/, "")}/approvals/${req.id}`;
  const lines = [
    `${label} ${req.doc_ref} (revision ${req.revision}) - ${HEADLINE[kind]}`,
    "",
    `Customer: ${req.customer_name ?? "-"}`,
    `Project: ${req.project_ref ?? "-"}`,
    `Type: ${label}`,
    `Amount (ex VAT): ${rand(req.amount_cents)}`,
    `Prepared by: ${req.prepared_by_email}`,
    `Assigned approver: ${opts.newApprover ?? req.assigned_to_email ?? opts.anyOf ?? "any manager"}`,
    `Submitted: ${formatSast(req.submitted_at)}`,
    req.due_at ? `Approval due: ${formatSast(req.due_at)}` : "",
    opts.by ? `By: ${opts.by}` : "",
    safeReason(opts.reason) ? `Reason: ${safeReason(opts.reason)}` : "",
    "",
    `Required action: ${ACTION[kind]}`,
    `Open: ${link}`,
  ].filter((l, i, a) => l !== "" || a[i - 1] !== "");
  return { kind: opts.kindKey ?? kind, recipient: to.toLowerCase(), subject: `NewQuip ${label} ${req.doc_ref}: ${HEADLINE[kind]}`, body: lines.join("\n") };
}
