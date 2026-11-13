"use server";

// NewQuip: the Estimator supplier-pricing workspace (NQ-008B Phase 2). INTERNAL: supplier costs, rates, freight, markup and margin. Every action re-establishes the same
// authority as the rest of the Estimator workflow (NewQuip organisation, module access, Estimator or Manager role AND cost visibility) and none writes to Cin7 or Xero.
// The change and its immutable revision are one database transaction; the existing amount-change workflow then withdraws the Rep's confirmation when the customer total moved.
// Only async functions and erased types are exported.
import { createServiceRoleClient } from "@/supabase/server";
import { applyPricingChange, attestRates, loadPricingWorkspace, recordManualEvidence, verifyCosts, type ApplyReport, type PricingActor, type WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import type { PricingSubmission } from "@/newquip/pricing/estimator/apply";
import { auditActor, authoriseActor, errText as rawErrText, type Actor } from "./actor";

/** Unexpected programming errors (a malformed request) are not echoed to the browser; our own plain-language messages are. */
const errText = (e: unknown): string => (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError ? "The pricing request was not valid." : rawErrText(e));

export interface PricingActionResult<T> { ok: boolean; error?: string; errors?: string[]; data?: T }

const asPricingActor = (a: Actor): PricingActor => ({ orgId: a.orgId, userId: a.userId, email: a.email, roles: a.roles, canSeeCost: a.canSeeCost });
/** Supplier pricing is cost data: like the cost actions, it is not available while a Demo Mode identity is active. */
async function pricingActor(): Promise<Actor> {
  const a = await authoriseActor();
  if (a.demo) throw new Error("Supplier pricing is not available in Demo Mode.");
  return a;
}
async function run(quoteId: string, submission: PricingSubmission | null, reason: string): Promise<PricingActionResult<ApplyReport>> {
  if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || typeof reason !== "string") throw new TypeError("bad request");
  const a = await pricingActor();
  const db = createServiceRoleClient();
  const r = await applyPricingChange(db, asPricingActor(a), quoteId, submission, reason);
  if (!r.ok) return { ok: false, error: r.errors[0], errors: r.errors };
  await auditActor(db, a, { action: "newquip.pricing_revision", summary: "Recorded an Estimator pricing revision (local only; no Cin7 write)", detail: { quoteId, seq: r.report.seq, kind: r.report.kind, changedValues: r.report.changedValues, customerConfirmationWithdrawn: !!r.report.confirmation } });
  return { ok: true, data: r.report };
}

export async function getEstimatorPricingAction(quoteId: string): Promise<PricingActionResult<WorkspaceBundle>> {
  try {
    const a = await pricingActor();
    return { ok: true, data: await loadPricingWorkspace(createServiceRoleClient(), asPricingActor(a), quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Records the submitted pricing as one immutable revision (the first one switches the model on for this quotation). */
export async function applyEstimatorPricingAction(quoteId: string, submission: PricingSubmission, reason: string): Promise<PricingActionResult<ApplyReport>> {
  try {
    return await run(quoteId, submission, reason);
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Switches the model off for this quotation (recorded as a revision): it returns to the POC price source. */
export async function disableEstimatorPricingAction(quoteId: string, reason: string): Promise<PricingActionResult<ApplyReport>> {
  try {
    return await run(quoteId, null, reason);
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** An INDEPENDENT review of supplier costs (not the person who entered them). Prices and the customer total do not change. */
export async function verifyEstimatorCostsAction(quoteId: string, items: Array<{ sku: string; costHash: string }>, evidence: string): Promise<PricingActionResult<{ seq: number; verified: number }>> {
  try {
    const a = await pricingActor();
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || !Array.isArray(items) || items.length > 300 || items.some((i) => !i || typeof i.sku !== "string" || typeof i.costHash !== "string") || typeof evidence !== "string") throw new TypeError("bad request");
    const db = createServiceRoleClient();
    const r = await verifyCosts(db, asPricingActor(a), quoteId, items.map((i) => ({ sku: i.sku, costHash: i.costHash })), evidence);
    if (!r.ok) return { ok: false, error: r.errors[0], errors: r.errors };
    await auditActor(db, a, { action: "newquip.cost_verification", summary: "Recorded an independent verification of supplier costs (local only; no Cin7 write)", detail: { quoteId, seq: r.report.seq, verified: r.report.verified } });
    return { ok: true, data: r.report };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** An INDEPENDENT attestation of forward-cover rates (not the person who entered them). Prices and the customer total do not change. */
export async function attestEstimatorRatesAction(quoteId: string, items: Array<{ currency: string; rateHash: string }>, evidence: string): Promise<PricingActionResult<{ seq: number; attested: number }>> {
  try {
    const a = await pricingActor();
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || !Array.isArray(items) || items.length > 20 || items.some((i) => !i || typeof i.currency !== "string" || typeof i.rateHash !== "string") || typeof evidence !== "string") throw new TypeError("bad request");
    const db = createServiceRoleClient();
    const r = await attestRates(db, asPricingActor(a), quoteId, items.map((i) => ({ currency: i.currency, rateHash: i.rateHash })), evidence);
    if (!r.ok) return { ok: false, error: r.errors[0], errors: r.errors };
    await auditActor(db, a, { action: "newquip.rate_attestation", summary: "Recorded an independent attestation of forward-cover rates (local only; no Cin7 write)", detail: { quoteId, seq: r.report.seq, attested: r.report.attested } });
    return { ok: true, data: r.report };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Pricing evidence for SKU-less manual items (M75, LED lighting, penning, any manual item). The server binds each note to the item's current price; no price changes. */
export async function recordManualPriceEvidenceAction(quoteId: string, items: Array<{ itemKey: string; note: string; reference?: string }>): Promise<PricingActionResult<{ seq: number; recorded: number }>> {
  try {
    const a = await pricingActor();
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || !Array.isArray(items) || items.length > 100 || items.some((i) => !i || typeof i.itemKey !== "string" || typeof i.note !== "string" || (i.reference !== undefined && typeof i.reference !== "string"))) throw new TypeError("bad request");
    const db = createServiceRoleClient();
    const r = await recordManualEvidence(db, asPricingActor(a), quoteId, items.map((i) => ({ itemKey: i.itemKey, note: i.note, ...(i.reference !== undefined ? { reference: i.reference } : {}) })));
    if (!r.ok) return { ok: false, error: r.errors[0], errors: r.errors };
    await auditActor(db, a, { action: "newquip.manual_price_evidence", summary: "Recorded pricing evidence for manual items (local only; no Cin7 write)", detail: { quoteId, seq: r.report.seq, recorded: r.report.recorded } });
    return { ok: true, data: r.report };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
