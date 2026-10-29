// Approval policy (pure). The database repeats the state, version, digest, reason and separation checks; this layer gives the early, readable error
// and decides who may act. Hidden buttons are never the control: every server action calls these again.
import type { ApprovalAction, ApprovalRequestRow } from "./types";

export interface Actor { email: string; isManager: boolean }
export type Verdict = { ok: true; override: boolean } | { ok: false; error: string };
const lc = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/**
 * Who may take which action. Approve / return / reject: a manager (org owner/admin) only. Withdraw: the preparer or a manager.
 * A manager who prepared the submission may approve it ONLY as an explicit override, with a written reason (permanently recorded).
 */
export function authoriseDecision(a: Actor, action: ApprovalAction, req: Pick<ApprovalRequestRow, "status" | "prepared_by_email">, input: { reason?: string; override?: boolean }): Verdict {
  if (req.status !== "PENDING") return { ok: false, error: `This submission is already ${req.status.toLowerCase()}.` };
  const reason = (input.reason ?? "").trim();
  if (action === "WITHDRAW") return a.isManager || lc(a.email) === lc(req.prepared_by_email) ? { ok: true, override: false } : { ok: false, error: "Only the preparer or a manager can withdraw a submission." };
  if (!a.isManager) return { ok: false, error: "Only a manager (organisation owner or admin) can approve, return or reject a submission." };
  if ((action === "RETURN" || action === "REJECT") && reason.length < 3) return { ok: false, error: action === "RETURN" ? "Explain what must change: a written reason is required to return a submission." : "A written reason is required to reject a submission." };
  if (action === "APPROVE" && lc(a.email) === lc(req.prepared_by_email)) {
    if (!input.override) return { ok: false, error: "You prepared this submission, so you cannot approve it normally. A manager may approve their own submission only as an explicit override with a written reason, on the Approvals page." };
    if (reason.length < 10) return { ok: false, error: "An override needs a written reason (at least a short sentence)." };
    return { ok: true, override: true };
  }
  return { ok: true, override: false };
}
