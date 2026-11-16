"use server";

// NewQuip: adopting the CURRENT Grower template revision on an EXISTING quotation. An existing quotation keeps the template it was created under, so nothing that changes the template can silently
// re-scope or re-price it. Moving it is a deliberate, audited, Estimator-only commercial decision: the Estimator sees old v new components, quantities and selling values, must acknowledge those exact
// figures, gives a reason, and the change goes through the normal draft save (compare-and-set on the draft hash, sign-off withdrawn) and the normal confirmation controls (a changed quotation sends
// the Rep back to reconfirm as a new revision). Only async functions and erased types are exported. No Cin7 write; no pricing-engine change.
import { createServiceRoleClient } from "@/supabase/server";
import { loadQuote, invalidateConfirmation, saveDraft } from "@/lib/newquip-quotes/quote-store";
import { resyncApprovalsLogged } from "@/lib/newquip-quotes/confirmation-reconcile";
import { returnByOf } from "@/lib/newquip-quotes/return-store";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { adoptedDraft, adoptionImpact, type AdoptionImpact } from "@/newquip/quote/template-adoption";
import { authoriseActor, auditActor, errText } from "./actor";

export interface AdoptionResult<T> { ok: boolean; error?: string; data?: T }
export interface AdoptionPreview { impact: AdoptionImpact; draftHash: string; revision: number; state: string }
export interface AdoptionOutcome { revision: number; returnedToRep: boolean; confirmationWithdrawn: boolean; signoffCleared: boolean; totalExVat: number; totalComplete: boolean }

async function estimatorActor() {
  const a = await authoriseActor();
  if (a.demo) throw new Error("Template adoption is not available in Demo Mode.");
  if (!a.roles.has("estimator")) throw new Error("Only an Estimator can move a quotation to the current template.");
  return a;
}
const stateOf = (q: { state: string; customer_confirmed_cents: number | null; customer_confirmed_by: string | null; estimator_signoff_hash: string | null }) => ({ state: q.state, customerConfirmed: q.customer_confirmed_cents != null || q.customer_confirmed_by != null, signedOff: q.estimator_signoff_hash != null });

/** READ-ONLY. What adopting the current template revision would change on this quotation. Writes nothing. */
export async function previewTemplateAdoptionAction(quoteId: string): Promise<AdoptionResult<AdoptionPreview>> {
  try {
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64) throw new Error("The request was not valid.");
    const a = await estimatorActor();
    const q = await loadQuote(createServiceRoleClient(), a.orgId, quoteId);
    if (!q) return { ok: false, error: "Quote not found." };
    return { ok: true, data: { impact: adoptionImpact(q.draft, stateOf(q), evaluationContext(false)), draftHash: q.draft_hash, revision: q.revision, state: q.state } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/**
 * Moves ONE existing quotation to the current template revision. Refused unless: the caller is an Estimator, the quotation is not approved, the preview the caller saw is still current (draft hash),
 * the impact is acknowledged, the acknowledged total matches what the server computes now, and a reason is given. The new LED package is confirmed only if the Estimator says so here.
 */
export async function adoptTemplateRevisionAction(quoteId: string, input: { reason: string; expectedDraftHash: string; acknowledgeImpact: boolean; acknowledgedTotalExVat: number; confirmNewLedPackage: boolean }): Promise<AdoptionResult<AdoptionOutcome>> {
  try {
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || !input || typeof input.reason !== "string" || typeof input.expectedDraftHash !== "string") throw new Error("The request was not valid.");
    const a = await estimatorActor();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) return { ok: false, error: "Quote not found." };
    const confirm = input.confirmNewLedPackage === true;
    const impact = adoptionImpact(q.draft, stateOf(q), evaluationContext(false));
    if (!impact.eligible) return { ok: false, error: impact.refusal ?? "This quotation cannot adopt the current template." };
    if (q.draft_hash !== input.expectedDraftHash) return { ok: false, error: "The quotation changed since you reviewed the impact. Review it again." };
    if (input.acknowledgeImpact !== true) return { ok: false, error: "Acknowledge the commercial impact first." };
    if (input.reason.trim().length < 10) return { ok: false, error: "Give a reason of at least 10 characters (it is recorded in the audit history)." };
    const shown = (confirm ? impact.totals.afterConfirmed : impact.totals.afterUnconfirmed).exVat;
    if (typeof input.acknowledgedTotalExVat !== "number" || Math.round(input.acknowledgedTotalExVat * 100) !== Math.round(shown * 100)) return { ok: false, error: "The acknowledged total does not match the impact now computed. Review it again." };

    const next = adoptedDraft(q.draft, { confirmNewLedPackage: confirm });
    const who = { orgId: a.orgId, userId: a.userId, email: a.email, isAdmin: a.tier === "admin", demo: a.demo };
    // ORDER MATTERS (the safe direction first). 1) Withdraw the customer's confirmation of the OLD amount (compare-and-set on state, revision and amount; from estimator review the quotation returns to the
    // Rep as a new revision). If that fails nothing has changed. 2) Move the template, compare-and-set on the EXACT draft hash the Estimator reviewed. If THAT fails after step 1, the quotation is on its
    // original template with the confirmation withdrawn: a conservative, visible, audited state, never a moved template with a live confirmation.
    const hadConfirmation = q.customer_confirmed_cents != null || q.customer_confirmed_by != null;
    const effect = hadConfirmation ? await invalidateConfirmation(db, a.orgId, quoteId, returnByOf(a), { cents: q.customer_confirmed_cents, revision: q.revision }, { kind: "AMOUNT_CHANGED", newCents: Math.round(shown * 100) }) : { returnedToRep: false, signoffCleared: false, confirmationCleared: false };
    let saved: { draftHash: string; signoffCleared: boolean };
    try {
      saved = await saveDraft(db, a.orgId, a.roles, quoteId, next, null, { keepStoredPricing: true, adoptTemplateRevision: true, expectedDraftHash: input.expectedDraftHash });
    } catch (e) {
      await auditActor(db, a, { action: "newquip.template_revision_adoption_failed", summary: `Template adoption for ${q.quote_ref} FAILED after the customer confirmation was withdrawn: the quotation is still on ${impact.from} (local only)`, detail: { quoteId, from: impact.from, reason: input.reason.trim(), confirmationWithdrawn: effect.confirmationCleared, returnedToRep: effect.returnedToRep, error: errText(e) } }).catch(() => undefined);
      return { ok: false, error: `${errText(e)} The quotation was NOT moved to the current template${effect.confirmationCleared ? "; the customer's confirmation was withdrawn, so the Rep must reconfirm the amount" : ""}.` };
    }
    const signoffCleared = saved.signoffCleared || effect.signoffCleared;
    const after = await loadQuote(db, a.orgId, quoteId);
    await auditActor(db, a, {
      action: "newquip.template_revision_adopted",
      summary: `Moved NewQuip quote ${q.quote_ref} from template ${impact.from} to ${impact.to} (local only; no Cin7 write)`,
      detail: { quoteId, from: impact.from, to: impact.to, reason: input.reason.trim(), confirmedNewLedPackage: confirm, totalBeforeExVat: impact.totals.before.exVat, totalAfterExVat: shown, ledBefore: impact.led.before?.components.map((c) => [c.sku, c.quantity]) ?? null, ledAfter: (confirm ? impact.led.afterConfirmed : impact.led.afterUnconfirmed)?.components.map((c) => [c.sku, c.quantity]) ?? null, confirmationWithdrawn: effect.confirmationCleared, signoffCleared, returnedToRep: effect.returnedToRep },
    });
    const syncErr = await resyncApprovalsLogged(db, who, quoteId, { returnedToRep: effect.returnedToRep, signoffCleared }).catch(() => null);
    void syncErr;
    return { ok: true, data: { revision: after?.revision ?? q.revision, returnedToRep: effect.returnedToRep, confirmationWithdrawn: effect.confirmationCleared, signoffCleared, totalExVat: shown, totalComplete: (confirm ? impact.totals.afterConfirmed : impact.totals.afterUnconfirmed).complete } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
