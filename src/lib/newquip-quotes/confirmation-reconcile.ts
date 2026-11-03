import "server-only";
// ONE place that withdraws a pre-approval customer confirmation when the commercial amount changed, and the shared (non-silent) approval re-sync used by every writer.
// Used by every action that writes draft content (saveGrowerDraftAction, the cost writers). Cost-only edits do not change the commercial total, so they are a no-op here.
import type { createServiceRoleClient } from "@/supabase/server";
import { evaluateDraft, type EvaluationContext } from "@/newquip/grower/evaluate";
import { logActivity } from "@/lib/activity-log";
import { demoAuditDetail, type DemoInfo } from "@/lib/demo-mode/context";
import { legacyCtx, resyncQuoteApprovals, stagedAvailable } from "@/lib/approvals/approval-store";
import { invalidateConfirmation, loadQuote } from "./quote-store";
import { confirmationStatus } from "./confirmation-status";

type Db = ReturnType<typeof createServiceRoleClient>;
export interface Who { orgId: string; userId: string; email: string; isAdmin?: boolean; demo?: DemoInfo | null }
export interface InvalidationEffect { confirmationCleared: boolean; signoffCleared: boolean; returnedToRep: boolean; approvalSyncError?: string }
export interface AmountInvalidation extends InvalidationEffect { previousCents: number; newCents: number }

const audit = (db: Db, w: Who, i: { action: string; summary: string; detail: Record<string, unknown> }) => logActivity(db, w.demo
  ? { orgId: w.orgId, actor: { userId: w.demo.ownerUserId, email: w.demo.ownerEmail }, action: i.action, summary: `[DEMO] ${i.summary}`, detail: demoAuditDetail(w.demo, i.detail) }
  : { orgId: w.orgId, actor: { userId: w.userId, email: w.email }, action: i.action, summary: i.summary, detail: i.detail });

/**
 * Re-syncs the approval request after the quotation went back to the Rep or lost its sign-off. A failure is NOT swallowed: it is audited and returned
 * (the quotation row stays authoritative; the stale request is reconciled by the next sync). Returns the message, or null on success / nothing to do.
 */
export async function resyncApprovalsLogged(db: Db, w: Who, quoteId: string, effect: Pick<InvalidationEffect, "returnedToRep" | "signoffCleared">): Promise<string | null> {
  if (!(effect.returnedToRep || effect.signoffCleared) || !(await stagedAvailable(db))) return null;
  try {
    await resyncQuoteApprovals(db, legacyCtx(w.orgId, w.userId, w.email, w.isAdmin ?? false, w.demo ? { name: w.demo.actorName, demo: w.demo } : undefined), quoteId, { quiet: true });
    return null;
  } catch (e) {
    const message = `The approval request could not be updated: ${e instanceof Error ? e.message : "unknown error"}`;
    await audit(db, w, { action: "newquip.approval_resync_failed", summary: "Could not update the approval request after the quotation changed (local only)", detail: { quoteId, error: message } }).catch(() => undefined);
    return message;
  }
}

/** The commercial total (ex VAT, cents) of a quotation's draft under the workflow's cost-WITHHELD evaluation; null when no total can be computed. */
export const commercialTotalCents = (draft: Parameters<typeof evaluateDraft>[0], ctx: EvaluationContext): number | null => {
  const ev = evaluateDraft(draft, ctx);
  return ev.budget && !ev.budget.incomplete ? Math.round(ev.budget.totals.subtotalExTax * 100) : null;
};

/**
 * Call after ANY write of draft content. When a confirmation exists and the commercial total (ex VAT) now differs from the confirmed amount, the confirmation and sign-off
 * are withdrawn (in estimator review the quotation returns to the Rep as a new revision), audited and the approval request re-synced. Returns the facts for the UI, or
 * null when nothing was withdrawn. An undeterminable total does not withdraw (approval still fails closed on it).
 */
export async function reconcileConfirmationAmount(db: Db, w: Who, quoteId: string, ctx: EvaluationContext): Promise<AmountInvalidation | null> {
  const q = await loadQuote(db, w.orgId, quoteId);
  if (!q || q.customer_confirmed_cents == null || q.state === "MANAGER_APPROVED_FINAL") return null;
  const previousCents = q.customer_confirmed_cents; // captured now: a row object may be updated in place by the clear below
  const total = commercialTotalCents(q.draft, ctx);
  if (total == null || confirmationStatus(q, total, null) !== "amount_changed") return null;
  const effect = await invalidateConfirmation(db, w.orgId, quoteId, { cents: previousCents, revision: q.revision });
  if (!effect.confirmationCleared) return null;
  await audit(db, w, { action: "newquip.quote_confirmation_invalidated", summary: "Withdrew the customer's pre-approval price confirmation: the quotation total changed (local only)", detail: { quoteId, reason: "AMOUNT_CHANGED", previousCents, newCents: total, ...effect } });
  const approvalSyncError = await resyncApprovalsLogged(db, w, quoteId, effect);
  return { ...effect, previousCents, newCents: total, ...(approvalSyncError ? { approvalSyncError } : {}) };
}
