import "server-only";
// Server-side guard for the customer confirmation: a stale confirmation (confirmed contact changed, or total no longer the confirmed amount) must not be signed off or
// approved. Read-only. Callable from estimatorSignOff / approval paths (the sign-off amount check itself is owned by the sign-off stream; this is the shared hook).
import type { createServiceRoleClient } from "@/supabase/server";
import { evaluateDraft, type EvaluationContext } from "@/newquip/grower/evaluate";
import { loadQuote } from "./quote-store";
import { latestSnapshot } from "./customer-store";
import { confirmationBlockReason, confirmationStatus, type ConfirmationStatus } from "./confirmation-status";

type Db = ReturnType<typeof createServiceRoleClient>;

/** Throws a plain-language error when the quotation's confirmation is not `valid` for its CURRENT content. Returns the (valid) status otherwise. */
export async function assertConfirmationCurrent(db: Db, orgId: string, quoteId: string, ctx: EvaluationContext): Promise<ConfirmationStatus> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  const ev = evaluateDraft(q.draft, ctx);
  const total = ev.budget && !ev.budget.incomplete ? Math.round(ev.budget.totals.subtotalExTax * 100) : null;
  const snap = (await latestSnapshot(db, orgId, quoteId))?.snapshot ?? null;
  const status = confirmationStatus(q, total, snap);
  const reason = confirmationBlockReason(status);
  if (reason) throw new Error(reason);
  return status;
}
