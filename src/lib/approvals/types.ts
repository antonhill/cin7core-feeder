// NewQuip commercial approvals - shared types (pure; safe for client and server).
export type ApprovalDocType = "QUOTE" | "CLAIM" | "VARIATION";
export const DOC_TYPE_LABEL: Record<ApprovalDocType, string> = { QUOTE: "Quote", CLAIM: "Claim", VARIATION: "Variation" };
export type ApprovalStatus = "PENDING" | "APPROVED" | "RETURNED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED";
/** What the preparer sees: DRAFT is the document before any submission; the rest are request states. */
export const STATUS_LABEL: Record<ApprovalStatus, string> = {
  PENDING: "Pending approval", APPROVED: "Approved", RETURNED: "Returned for changes", REJECTED: "Rejected", WITHDRAWN: "Withdrawn", SUPERSEDED: "Superseded",
};
export type ApprovalAction = "APPROVE" | "RETURN" | "REJECT" | "WITHDRAW";

export interface ApprovalRequestRow {
  id: string; org_id: string; doc_type: ApprovalDocType; doc_id: string; doc_ref: string; project_id: string | null; project_ref: string | null; customer_name: string | null;
  revision: number; digest: string; amount_cents: number; status: ApprovalStatus; prepared_by_email: string; submitted_at: string; assigned_to_email: string | null; assigned_at: string | null;
  due_at: string | null; first_viewed_at: string | null; decided_by_email: string | null; decided_by_name: string | null; decided_at: string | null; decision_reason: string | null;
  admin_override: boolean; closed_at: string | null; version: number; reminders_sent: number; last_reminder_at: string | null; created_at: string;
}
export interface ApprovalEventRow {
  id: string; request_id: string; doc_type: ApprovalDocType; doc_id: string; doc_ref: string; revision: number; project_id: string | null;
  action: string; from_status: string | null; to_status: string | null; actor_email: string; actor_name: string | null; reason: string | null; digest: string; created_at: string;
}
export interface ApprovalNotificationRow {
  id: string; request_id: string; kind: string; recipient_email: string; channel: "IN_APP" | "EMAIL"; subject: string; body: string; dedupe_key: string;
  status: "PENDING" | "SENT" | "FAILED" | "ABANDONED"; attempts: number; last_error: string | null; provider_message_id: string | null; sent_at: string | null; read_at: string | null; created_at: string;
}
export interface ApprovalSettings { targetBusinessDays: number; reminderEveryHours: number; maxReminders: number; escalationEmail: string | null }
export const DEFAULT_APPROVAL_SETTINGS: ApprovalSettings = { targetBusinessDays: 2, reminderEveryHours: 24, maxReminders: 3, escalationEmail: null };
