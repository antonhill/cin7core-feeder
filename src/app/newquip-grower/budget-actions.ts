"use server";

// NewQuip: the BUDGET QUOTATION actions (customer UAT feedback). A Rep previews a provisional PDF and may send it to a customer (UAT: only an authorised test mailbox). LOCAL ONLY: nothing here reaches
// Cin7, approves, issues, accepts or creates a Project; the only record is the audit trail. Re-authorised inside EVERY action. Only async functions and erased types are exported.
import { authoriseActor, errText } from "./actor";
import { createServiceRoleClient } from "@/supabase/server";
import { budgetSendRefusal, prepareBudget, sendBudgetQuotation } from "@/lib/newquip-quotes/budget-quotation";
import { latestProfile } from "@/lib/newquip-quotes/document-store";
import { describeProfileProblems, profileProblems } from "@/lib/newquip-quotes/company-profile";
import { isRestricted } from "@/lib/approvals/email-policy";

export interface BudgetActionResult<T> { ok: boolean; error?: string; data?: T }
export interface BudgetStatus {
  /** The Rep may send (role, state, environment and company details all allow it). */
  canSend: boolean; blockedReason: string | null; testMode: boolean;
  /** The saved draft this status describes: the preview and the send are bound to it. */
  draftHash: string; draftRef: string;
  complete: boolean; unpricedCount: number; unpricedItems: string[];
  /** Where a test email goes in UAT (an authorised mailbox), or null outside test mode. */
  testRecipient: string | null;
}

const ID = /^[0-9a-f-]{36}$/i;

export async function getBudgetStatusAction(quoteId: string): Promise<BudgetActionResult<BudgetStatus>> {
  try {
    const a = await authoriseActor();
    if (!a.roles.has("rep") && !a.roles.has("estimator") && !a.roles.has("manager")) throw new Error("Not authorised.");
    if (!ID.test(quoteId)) throw new Error("Quotation not found.");
    const db = createServiceRoleClient();
    const prep = await prepareBudget(db, a.orgId, quoteId, process.env);
    const prof = await latestProfile(db, a.orgId);
    const problems = prof ? describeProfileProblems(profileProblems(prof.profile)) : ["no company details have been saved"];
    const refusal = a.roles.has("rep") ? budgetSendRefusal(process.env, !!prof && problems.length === 0, problems) : "Only a Rep sends a budget quotation.";
    const testRecipient = isRestricted(process.env) ? (process.env.NEWQUIP_UAT_TEST_CUSTOMER_EMAIL?.trim() || "anton@sparkconsulting.co.za").toLowerCase() : null;
    return { ok: true, data: { canSend: !refusal, blockedReason: refusal, testMode: prep.testMode, draftHash: prep.draftHash, draftRef: prep.model.quote.draftRef, complete: prep.model.complete, unpricedCount: prep.model.unpriced.count, unpricedItems: prep.model.unpriced.items, testRecipient } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export async function sendBudgetQuotationAction(quoteId: string, req: { to: string; message?: string; idempotencyKey: string; expectedDraftHash: string; acknowledgeIncomplete?: boolean }): Promise<BudgetActionResult<{ status: string; to: string; reused: boolean; testMode: boolean; incompleteCount: number }>> {
  try {
    const a = await authoriseActor();
    if (!ID.test(quoteId)) throw new Error("Quotation not found.");
    const r = await sendBudgetQuotation(createServiceRoleClient(), { orgId: a.orgId, userId: a.userId, email: a.email, isRep: a.roles.has("rep") }, quoteId, req, process.env);
    if (r.status !== "ACCEPTED") return { ok: false, error: r.status === "SUPPRESSED" ? "Nothing was sent: that address is not permitted from this environment." : "The email provider did not accept the message. Nothing was delivered." };
    return { ok: true, data: { status: r.status, to: r.to, reused: r.reused, testMode: r.testMode, incompleteCount: r.incompleteCount } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
