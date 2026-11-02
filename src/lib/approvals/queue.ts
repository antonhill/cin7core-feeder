// The combined approval queue: filtering, sorting and the summary cards, all computed from canonical request rows (never from counters). Pure.
import { isOverdue } from "./time";
import type { ApprovalDocType, ApprovalRequestRow, ApprovalStatus } from "./types";

export interface QueueFilters {
  mine?: boolean; docType?: ApprovalDocType; customer?: string; project?: string; preparer?: string; assignee?: string; status?: ApprovalStatus | "ANY";
  from?: string; to?: string; overdueOnly?: boolean;
}
export type QueueSort = "submitted_desc" | "submitted_asc" | "waiting_desc" | "amount_desc" | "amount_asc";
const lc = (s: string | null | undefined) => (s ?? "").toLowerCase();

export function filterQueue(rows: readonly ApprovalRequestRow[], f: QueueFilters, me: string, nowIso: string, myRoles?: ReadonlySet<string>): ApprovalRequestRow[] {
  return rows.filter((r) => {
    if (f.mine && !(r.status === "PENDING" ? awaitsMe(r, me, myRoles) : lc(r.assigned_to_email) === lc(me))) return false;
    if (f.docType && r.doc_type !== f.docType) return false;
    if (f.customer?.trim() && !lc(r.customer_name).includes(lc(f.customer?.trim()))) return false;
    if (f.project?.trim() && !(lc(r.project_ref).includes(lc(f.project?.trim())) || lc(r.doc_ref).includes(lc(f.project?.trim())))) return false;
    if (f.preparer?.trim() && !lc(r.prepared_by_email).includes(lc(f.preparer?.trim()))) return false;
    if (f.assignee?.trim() && !lc(r.assigned_to_email).includes(lc(f.assignee?.trim()))) return false;
    if (f.status && f.status !== "ANY" && r.status !== f.status) return false;
    if (f.from && r.submitted_at < f.from) return false;
    if (f.to && r.submitted_at > f.to) return false;
    if (f.overdueOnly && !(r.status === "PENDING" && isOverdue(r.due_at, nowIso))) return false;
    return true;
  });
}

export function sortQueue(rows: readonly ApprovalRequestRow[], by: QueueSort): ApprovalRequestRow[] {
  const out = [...rows];
  const t = (r: ApprovalRequestRow) => new Date(r.submitted_at).getTime();
  switch (by) {
    case "submitted_asc": case "waiting_desc": return out.sort((a, b) => t(a) - t(b)); // the longest wait is the oldest submission
    case "amount_desc": return out.sort((a, b) => b.amount_cents - a.amount_cents);
    case "amount_asc": return out.sort((a, b) => a.amount_cents - b.amount_cents);
    default: return out.sort((a, b) => t(b) - t(a));
  }
}

export interface QueueSummary {
  awaitingMe: number; pending: number; overdue: number; returned: number; approvedToday: number; approvedThisWeek: number; rejected: number;
  /** Ex VAT value of everything currently PENDING (quotes: confirmed contract value; claims: claim subtotal; variations: variation amount). Mixed document types are summed because each is a commercial value awaiting approval. */
  pendingValueCents: number;
}
const sastDayStart = (nowIso: string) => { const d = new Date(new Date(nowIso).getTime() + 2 * 3_600_000); d.setUTCHours(0, 0, 0, 0); return d.getTime() - 2 * 3_600_000; };

/** Waiting for ME: assigned to me by name, or unassigned and I hold the role of its stage. */
export const awaitsMe = (r: ApprovalRequestRow, me: string, myRoles?: ReadonlySet<string>): boolean =>
  lc(r.assigned_to_email) === lc(me) || (!r.assigned_to_email && !!r.stage_role && !!myRoles?.has(r.stage_role) && lc(r.prepared_by_email) !== lc(me));

export function summarise(rows: readonly ApprovalRequestRow[], me: string, nowIso: string, myRoles?: ReadonlySet<string>): QueueSummary {
  const dayStart = sastDayStart(nowIso);
  const d = new Date(dayStart + 2 * 3_600_000);
  const weekStart = dayStart - ((d.getUTCDay() + 6) % 7) * 86_400_000; // Monday, SAST
  const s: QueueSummary = { awaitingMe: 0, pending: 0, overdue: 0, returned: 0, approvedToday: 0, approvedThisWeek: 0, rejected: 0, pendingValueCents: 0 };
  for (const r of rows) {
    if (r.status === "PENDING") {
      s.pending += 1; s.pendingValueCents += r.amount_cents;
      if (awaitsMe(r, me, myRoles)) s.awaitingMe += 1;
      if (isOverdue(r.due_at, nowIso)) s.overdue += 1;
    } else if (r.status === "RETURNED") s.returned += 1;
    else if (r.status === "REJECTED") s.rejected += 1;
    else if (r.status === "APPROVED" && r.decided_at && r.stage !== "ESTIMATOR") { // an estimator sign-off is a stage, not a final approval
      const at = new Date(r.decided_at).getTime();
      if (at >= dayStart) s.approvedToday += 1;
      if (at >= weekStart) s.approvedThisWeek += 1;
    }
  }
  return s;
}

/** Returned items still need the preparer's action only while no newer revision of the same document exists. */
export function currentReturned(rows: readonly ApprovalRequestRow[]): ApprovalRequestRow[] {
  const latest = new Map<string, ApprovalRequestRow>();
  for (const r of rows) { const k = `${r.doc_type}:${r.doc_id}`; const c = latest.get(k); if (!c || r.revision > c.revision) latest.set(k, r); }
  return [...latest.values()].filter((r) => r.status === "RETURNED");
}

/** The filters that are ACTIVE (narrowing the list), as short labelled chips, so a hidden request is never a mystery. "Status: Any" is not active. */
export interface ActiveFilter { key: keyof QueueFilters; label: string }
export function activeFilters(f: QueueFilters, statusLabel: (s: ApprovalStatus) => string = (s) => s): ActiveFilter[] {
  const out: ActiveFilter[] = [];
  if (f.mine) out.push({ key: "mine", label: "My approvals" });
  if (f.docType) out.push({ key: "docType", label: `Type: ${f.docType.toLowerCase()}` });
  if (f.status && f.status !== "ANY") out.push({ key: "status", label: `Status: ${statusLabel(f.status)}` });
  if (f.customer?.trim()) out.push({ key: "customer", label: `Customer: ${f.customer.trim()}` });
  if (f.project?.trim()) out.push({ key: "project", label: `Project: ${f.project.trim()}` });
  if (f.preparer?.trim()) out.push({ key: "preparer", label: `Submitted by: ${f.preparer.trim()}` });
  if (f.assignee?.trim()) out.push({ key: "assignee", label: `Manager: ${f.assignee.trim()}` });
  if (f.from) out.push({ key: "from", label: `From ${f.from.slice(0, 10)}` });
  if (f.to) out.push({ key: "to", label: `To ${f.to.slice(0, 10)}` });
  if (f.overdueOnly) out.push({ key: "overdueOnly", label: "Overdue only" });
  return out;
}
/** Removes every narrowing filter (status goes to ANY, not back to the Pending default). */
export const CLEARED_FILTERS: QueueFilters = { status: "ANY" };
