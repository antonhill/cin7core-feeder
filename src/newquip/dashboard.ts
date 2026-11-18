// NewQuip dashboard: pure aggregation over rows the existing stores already load. Counts and labels ONLY: no monetary figure, cost, margin or supplier value is ever
// produced here, so nothing a Rep must not see can reach the dashboard (the dashboard component is handed these counts, never a quotation or project record).
import { hasAny, type QuoteRole } from "./quote/roles";
import type { QuoteState } from "./quote/workflow";

export interface QuoteStageCounts { repDraft: number; estimatorReview: number; managerDecision: number; approved: number; total: number }

/** Same stage reading as the quotation list: a signed-off quotation in estimator review is with the Manager. */
export function quoteStageCounts(rows: ReadonlyArray<{ state: QuoteState; signed_off: boolean }>): QuoteStageCounts {
  const c: QuoteStageCounts = { repDraft: 0, estimatorReview: 0, managerDecision: 0, approved: 0, total: rows.length };
  for (const r of rows) {
    if (r.state === "REP_DRAFT") c.repDraft++;
    else if (r.state === "MANAGER_APPROVED_FINAL") c.approved++;
    else if (r.signed_off) c.managerDecision++;
    else c.estimatorReview++;
  }
  return c;
}

export interface ClaimCounts { draft: number; open: number; approved: number }
const OPEN_CLAIM = new Set(["READY_FOR_APPROVAL", "FAILED_UNCERTAIN"]);
const APPROVED_CLAIM = new Set(["APPROVED", "CIN7_PENDING", "CIN7_CREATED", "RECONCILED"]);
/** DRAFT is being prepared; OPEN is awaiting approval or unresolved; APPROVED is approved onward (including posted). Failed-before-write and cancelled claims are in none. */
export function claimBucket(status: string): "draft" | "open" | "approved" | null {
  if (status === "DRAFT") return "draft";
  if (OPEN_CLAIM.has(status)) return "open";
  if (APPROVED_CLAIM.has(status)) return "approved";
  return null;
}
export function claimCounts(statuses: readonly string[]): ClaimCounts {
  const c: ClaimCounts = { draft: 0, open: 0, approved: 0 };
  for (const s of statuses) { const b = claimBucket(s); if (b) c[b]++; }
  return c;
}

export const activeProjectCount = (projects: ReadonlyArray<{ status: string }>): number => projects.filter((p) => p.status === "ACTIVE").length;

export interface QueueItem { label: string; count: number; href: string }
/** "Needs your action", by the process role(s) the viewer holds. Counts only. */
export function queueFor(roles: ReadonlySet<QuoteRole>, q: QuoteStageCounts): QueueItem[] {
  const items: QueueItem[] = [];
  if (hasAny(roles, ["rep"])) items.push({ label: "Quotations you are preparing", count: q.repDraft, href: "/newquip-grower" });
  if (hasAny(roles, ["estimator"])) items.push({ label: "Quotations to review and sign off", count: q.estimatorReview, href: "/newquip-grower" });
  if (hasAny(roles, ["manager"])) items.push({ label: "Quotations awaiting your decision", count: q.managerDecision, href: "/newquip-grower" });
  return items;
}
