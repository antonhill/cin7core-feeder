"use server";

// NewQuip: the Estimator supplier-pricing workspace (NQ-008B Phase 2). INTERNAL: supplier costs, rates, freight, markup and margin. Every action re-establishes the same
// authority as the rest of the Estimator workflow (NewQuip organisation, module access, cost visibility AND the role the action needs: ENTERING or CHANGING pricing needs the Estimator role; reading and independent cost verification / rate attestation are open to the reviewer role, the Manager) and none writes to Cin7 or Xero.
// The change and its immutable revision are one database transaction; the existing amount-change workflow then withdraws the Rep's confirmation when the customer total moved.
// Only async functions and erased types are exported.
import { createServiceRoleClient } from "@/supabase/server";
import { applyPricingChange, attestRates, loadPricingWorkspace, recordManualEvidence, verifyCosts, type ApplyReport, type PricingActor, type WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import type { PricingSubmission } from "@/newquip/pricing/estimator/apply";
import type { PricingConflict } from "@/newquip/pricing/estimator/merge";
import { runAutoPricingTopUp } from "@/lib/newquip-quotes/auto-pricing-service";
import { auditActor, authoriseActor, errText as rawErrText, type Actor } from "./actor";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { cin7IdentityLookups } from "@/lib/projects/latest-cost-adapter";
import { validateSupplierIdentities } from "@/newquip/pricing/estimator/supplier-identity";

/** Unexpected programming errors (a malformed request) are not echoed to the browser; our own plain-language messages are. */
const errText = (e: unknown): string => (e instanceof TypeError || e instanceof RangeError || e instanceof SyntaxError ? "The pricing request was not valid." : rawErrText(e));

export interface PricingActionResult<T> { ok: boolean; error?: string; errors?: string[]; data?: T; /** A save refused because the stored pricing changed since the base the edits were made against: which units conflict. */ conflicts?: PricingConflict[] }

const asPricingActor = (a: Actor): PricingActor => ({ orgId: a.orgId, userId: a.userId, email: a.email, roles: a.roles, canSeeCost: a.canSeeCost });
/** Supplier pricing is cost data: like the cost actions, it is not available while a Demo Mode identity is active. */
async function pricingActor(): Promise<Actor> {
  const a = await authoriseActor();
  if (a.demo) throw new Error("Supplier pricing is not available in Demo Mode.");
  return a;
}
/** What a successful pricing write returns: the revision report and (when it could be read) the workspace AS IT IS AFTER the write, so the page needs no second round trip to show it. */
type ApplyResult = ApplyReport & { workspace?: WorkspaceBundle };
async function run(quoteId: string, submission: PricingSubmission | null, reason: string, base: PricingSubmission | null): Promise<PricingActionResult<ApplyResult>> {
  if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64 || typeof reason !== "string") throw new TypeError("bad request");
  const a = await pricingActor();
  const db = createServiceRoleClient();
  // A NEW or CHANGED supplier cost must name an active Cin7 supplier by id, with its currency from that supplier's Cin7 record (or a reasoned override where Cin7 holds none). Checked here, on the server, against Cin7;
  // an unchanged entry is not re-checked. A failed Cin7 read refuses (it never guesses).
  if (submission) {
    const problems = await validateSupplierIdentities({ submission, base, lookups: cin7IdentityLookups(db, a.orgId, NEWQUIP_POC_CIN7_INSTANCE_ID), nowIso: new Date().toISOString() });
    if (problems.length > 0) return { ok: false, error: problems[0], errors: problems };
  }
  const r = await applyPricingChange(db, asPricingActor(a), quoteId, submission, reason, base);
  if (!r.ok) return { ok: false, error: r.errors[0], errors: r.errors, ...(r.conflicts ? { conflicts: r.conflicts } : {}) };
  // The audit record and the refreshed workspace are independent: one wait, not two. A failed audit fails the call exactly as before; a failed refresh only means the page reads it itself.
  const [, workspace] = await Promise.all([
    auditActor(db, a, { action: "newquip.pricing_revision", summary: "Recorded an Estimator pricing revision (local only; no Cin7 write)", detail: { quoteId, seq: r.report.seq, kind: r.report.kind, changedValues: r.report.changedValues, customerConfirmationWithdrawn: !!r.report.confirmation } }),
    loadPricingWorkspace(db, asPricingActor(a), quoteId).catch(() => undefined),
  ]);
  return { ok: true, data: { ...r.report, ...(workspace ? { workspace } : {}) } };
}

export async function getEstimatorPricingAction(quoteId: string): Promise<PricingActionResult<WorkspaceBundle>> {
  try {
    const a = await pricingActor();
    return { ok: true, data: await loadPricingWorkspace(createServiceRoleClient(), asPricingActor(a), quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

const NO_BASE = "This request did not say which saved pricing your edits were based on, so it was refused to avoid overwriting someone else's change. Reload the page and try again.";
const isBase = (x: unknown): boolean => x === null || (typeof x === "object" && !Array.isArray(x));

/**
 * Records the submitted pricing as one immutable revision (the first one switches the model on for this quotation). `base` is REQUIRED: the stored pricing these edits were made against
 * (null = pricing was off when loaded). The server merges field by field onto the CURRENT stored pricing and refuses on a real conflict; a missing base is refused (never last-write-wins).
 */
export async function applyEstimatorPricingAction(quoteId: string, submission: PricingSubmission, reason: string, base: PricingSubmission | null): Promise<PricingActionResult<ApplyResult>> {
  try {
    if (!isBase(base)) return { ok: false, error: NO_BASE, errors: [NO_BASE] };
    return await run(quoteId, submission, reason, base);
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Switches the model off for this quotation (recorded as a revision): it returns to the POC price source. `base` is REQUIRED and the switch-off is refused if the stored pricing changed since it. */
export async function disableEstimatorPricingAction(quoteId: string, reason: string, base: PricingSubmission | null): Promise<PricingActionResult<ApplyResult>> {
  try {
    if (!isBase(base)) return { ok: false, error: NO_BASE, errors: [NO_BASE] };
    return await run(quoteId, null, reason, base);
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

/**
 * The Estimator's "Price from Cin7": reads Cin7 (GET only) for the products the quotation needs that still have no stored cost (for example the door or package components chosen after the Rep's save) and records the automatic
 * costs through the SAME gated automatic pricing (runAutoPricingTopUp: add-only, so every stored entry is kept; refused for a quotation whose pricing a person has entered or changed). Costs stay unverified for a Manager.
 */
export async function priceFromCin7Action(quoteId: string): Promise<PricingActionResult<{ status: string; message: string; added: number; stillUnpriced: number; workspace?: WorkspaceBundle }>> {
  try {
    if (typeof quoteId !== "string" || quoteId.length === 0 || quoteId.length > 64) throw new TypeError("bad request");
    const a = await pricingActor();
    if (!a.roles.has("estimator") || !a.canSeeCost) return { ok: false, error: "Only an Estimator who can see costs can price from Cin7." };
    const db = createServiceRoleClient();
    const o = await runAutoPricingTopUp(db, { orgId: a.orgId, userId: a.userId, roles: a.roles, demo: false, canSeeCost: a.canSeeCost }, quoteId);
    console.info(`[newquip-auto-pricing] ${quoteId} at=estimator status=${o.status} added=${o.added} pending=${o.pendingCount} flags=${o.internal.map((i) => `${i.sku}:${i.code}`).join(",").slice(0, 400)}`);
    if (o.status === "applied") await auditActor(db, a, { action: "newquip.auto_pricing", summary: "Estimator priced newly needed products from Cin7 supplier costs (local only; Cin7 read only)", detail: { quoteId, added: o.added, stillPending: o.pendingCount, at: "estimator" } });
    // Estimator-only text (the action is refused to anyone else): which products were priced, which are still missing and the specific reason for each. No cost, rate or margin is in it.
    const stillMissing = o.internal.filter((i) => i.sku !== "*");
    const missingText = stillMissing.length > 0 ? ` Still without a cost: ${stillMissing.slice(0, 6).map((i) => `${i.sku} (${i.text.replace(/\.$/, "")})`).join("; ")}${stillMissing.length > 6 ? `; and ${stillMissing.length - 6} more` : ""}.` : "";
    const why = o.internal.find((i) => i.sku === "*")?.text;
    const message = o.status === "applied" ? `Priced ${o.added} product${o.added === 1 ? "" : "s"} from Cin7. The costs await Manager verification, and every cost already on the quotation was kept.${o.added > 0 ? " If the Rep had already confirmed an amount and the total has changed, the quotation returns to the Rep to reconfirm it." : ""}${missingText}`
      : o.status === "nothing_to_add" ? "Every product that needs a supplier cost already has one."
      : o.status === "no_prices" ? `Nothing could be priced from Cin7.${missingText || " The reason for each product is shown with it."}`
      : o.status === "not_applicable" ? `Price from Cin7 is not available here. ${why ?? "The quotation is not eligible."}`
      : o.status === "settings_incomplete" ? "A Manager must complete the commercial settings (freight policy and exchange rates) before costs can be priced from Cin7."
      : o.status === "settings_changed" ? "The commercial settings changed since this quotation was priced, so nothing was added automatically."
      : o.status === "skipped" ? "The quotation changed while its costs were being read, so nothing was priced. Try again."
      : "The costs could not be recorded. Nothing was changed.";
    const workspace = await loadPricingWorkspace(db, asPricingActor(a), quoteId).catch(() => undefined);
    return { ok: true, data: { status: o.status, message, added: o.added, stillUnpriced: o.pendingCount, ...(workspace ? { workspace } : {}) } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}
