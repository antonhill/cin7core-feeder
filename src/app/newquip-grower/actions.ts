"use server";

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { evaluateDraft, type QuoteEvaluation } from "@/newquip/grower/evaluate";
import { blankExclusions, previewDraftOf } from "@/newquip/grower/preview-draft";
import { emptyDraft, type QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor } from "@/newquip/quote/roles";
import { stampPriceResolutions } from "@/newquip/quote/price-resolution";
import { stampChanges } from "@/newquip/pricing/change-stamps";
import { keepServerOwnedPricing } from "@/newquip/pricing/estimator/ownership";
import { compareToIndicative, type IndicativeComparison } from "@/newquip/pricing/comparison";
import { allIndicativeSnapshots } from "@/lib/newquip-quotes/indicative-store";
import { keepEstimatorOwnedFields } from "@/newquip/quote/draft-ownership";
import { changedMappings, mappingsChanged, normaliseMappings } from "@/newquip/grower/mapping-integrity";
import { verifyMappings } from "@/lib/newquip-quotes/mapping-check";
import { searchCatalogue, type CatalogueResult } from "@/lib/projects/catalogue-search";
import { hasAny, PROJECT_CREATE_ROLES, type OrgTier, type QuoteRole } from "@/newquip/quote/roles";
import { toQuoteRoles } from "@/lib/approvals/roles";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { demoAuditDetail, resolveActing, type DemoInfo } from "@/lib/demo-mode/context";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { confirmationLabel, resolveConfirmationContact, type ConfirmationInput } from "@/lib/newquip-quotes/confirmation-contact";
import { returnByOf, returnInfoOf } from "@/lib/newquip-quotes/return-store";
import { returnInfoForViewer, type ReturnInfo } from "@/newquip/quote/return-info";
import { appendSnapshot, customerFeaturesAvailable, latestSnapshot } from "@/lib/newquip-quotes/customer-store";
import { fieldValue } from "@/lib/newquip-quotes/customer-snapshot";
import { reconcileConfirmationAmount, resyncApprovalsLogged } from "@/lib/newquip-quotes/confirmation-reconcile";
import { assertConfirmationCurrent, assertNameMatchesSnapshot } from "@/lib/newquip-quotes/confirmation-guard";
import { keepServerOwnedCostBasis, keepServerOwnedCosts, redactEvaluationFinancials, redactInternalFinancials, stampCostOverrides } from "@/newquip/quote/margin";
import { isPocQuote, pocPresentationEnabled, seedPocEstimator, POC_COST_REASON, POC_BASELINE_REASON } from "@/lib/newquip-quotes/poc-presentation";
import { approvalsAvailable, decideDocument, legacyCtx, resyncQuoteApprovals, stagedAvailable, submitForApproval, withdrawPendingFor } from "@/lib/approvals/approval-store";
import { BASELINE_EXCEPTION_TITLE, exceptionDecisionText, validateExceptionReason, type BaselineExceptionItem, type BaselineExceptionRequest, type BaselineExceptionView } from "@/newquip/quote/baseline-exception";
import type { ScheduleChoice } from "@/newquip/quote/billing-schedule";
import { resolveProjectSchedule } from "@/lib/newquip-quotes/schedule-resolve";
import {
  baselineExceptionOf, createProjectFromAcceptedQuote, costingOf, createQuote, estimatorSignOff, listQuotes, loadQuote, managerApprove, returnToRep, saveDraft, sendToEstimator,
  type QuoteRecord,
} from "@/lib/newquip-quotes/quote-store";

// NewQuip Grower POC server actions. LOCAL ONLY — nothing here reaches Cin7 or Xero (pinned by no-write.test.ts). Authorisation is
// re-established inside EVERY action (CCT-ADR-0010): the NewQuip org check + Quotes module access, then the actor's roles. The
// POC maps org tiers to roles (see src/newquip/quote/roles.ts): member → rep+estimator; owner/admin → +manager. Cost, ROE and
// freight are withheld from everyone who is not an owner/admin — server-side, so a browser never receives them.
//
// NOTE: a "use server" file may export ONLY async functions (types are erased and fine).

export interface GrowerActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** `canSeeCost`: owner/admin, or explicitly given the Estimator / Manager role. Cost, ROE, freight, margins and cost overrides are withheld from everyone else, server-side. */
interface Actor {
  /** The EFFECTIVE user (under Demo Mode, the allowlisted test account). Every permission and separation-of-duties check evaluates this one. */
  orgId: string; userId: string; email: string; tier: OrgTier; roles: ReadonlySet<QuoteRole>; canSeeCost: boolean;
  /** Set only while the owner is impersonating a demo identity; the real owner is then in demo.ownerEmail / demo.ownerUserId. */
  demo: DemoInfo | null;
}

async function authorise(): Promise<Actor> {
  const { orgId } = await requireNewquipPocOrg();
  // allowDemo: this is one of the scoped quotation / approval actions that resolve the effective identity themselves.
  const access = await requireModuleAccess(QUOTES_MODULE.href, { allowDemo: true });
  const acting = await resolveActing(access, QUOTES_MODULE.href);
  let tier: OrgTier = "member";
  if (acting.demo) {
    tier = acting.tier === "admin" ? "admin" : "member"; // the effective user's OWN tier, never the owner's
  } else {
    try {
      await requireOrgAdmin("act as a NewQuip manager");
      tier = "admin";
    } catch {
      tier = "member"; // fail closed: anything that is not provably admin is a plain member
    }
  }
  const db = createServiceRoleClient();
  // Functional roles (migration 0112) when assigned; otherwise exactly the tier-based roles of Phase H.
  const functional = await resolveRoles(db, orgId, acting.userId, tier === "admin");
  return { orgId, userId: acting.userId, email: acting.email, tier, roles: toQuoteRoles(functional), canSeeCost: await canSeeCosts(db, orgId, acting.userId, tier === "admin"), demo: acting.demo };
}

/** The approval context of the effective user. Under Demo Mode it carries the DEMO actor name and the real owner. */
function ctxOf(a: Actor, isManager: boolean = a.tier === "admin") {
  return legacyCtx(a.orgId, a.userId, a.email, isManager, a.demo ? { name: a.demo.actorName, demo: a.demo } : undefined);
}

const whoOf = (a: Actor) => ({ orgId: a.orgId, userId: a.userId, email: a.email, isAdmin: a.tier === "admin", demo: a.demo });

/** The audit record of any action: the REAL owner is the actor, the effective user and the DEMO marker are in the detail. */
async function audit(db: ReturnType<typeof createServiceRoleClient>, a: Actor, i: { action: string; summary: string; detail: Record<string, unknown> }) {
  await logActivity(db, a.demo
    ? { orgId: a.orgId, actor: { userId: a.demo.ownerUserId, email: a.demo.ownerEmail }, action: i.action, summary: `[DEMO] ${i.summary}`, detail: demoAuditDetail(a.demo, i.detail) }
    : { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: i.action, summary: i.summary, detail: i.detail });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

type ConfirmationEffectView = import("@/lib/newquip-quotes/confirmation-reconcile").InvalidationEffect & { previousCents?: number; newCents?: number };

/** A quote as the browser sees it: the record plus the viewer's roles. No cost ever travels in `evaluation` for non-admins. */
export interface QuoteView {
  /** Set only on a save that withdrew the customer's confirmation because the commercial total changed (previousCents -> newCents), or whose approval re-sync failed. */
  confirmationEffect?: ConfirmationEffectView;
  quote: QuoteRecord;
  evaluation: QuoteEvaluation;
  viewer: { roles: QuoteRole[]; canViewCommercials: boolean; /** SERVER-derived: true only on a Vercel Preview deployment (VERCEL_ENV === "preview"); never true in Production. Gates the whole-quote testing utility. */ previewTools: boolean };
  /** ESTIMATOR_COSTING_COMPLETE. Present ONLY for a caller who may see cost (Estimator / Manager / observer with cost); never in a Rep payload. `reason` is the first open reason (counts / labels / SKUs, never a value). */
  costing?: { complete: boolean; reason: string | null; /** Present when the Estimator's authorised accepted-incomplete-cost exception is what makes costing pass: a distinct state, not "complete". */ acceptedIncomplete?: { reason: string; by: string; at: string } };
  /**
   * WHY THE QUOTATION IS BACK (D5). Non-null only while the quotation is in the place a return/withdrawal sent it to (Rep draft revision >= 2, or Estimator review after a
   * Manager return): { kind, reason, byEmail, byRole, at, destination, previousCents?, newCents?, source }. Totals are ex VAT; no cost data. A viewer WITHOUT commercial visibility (a Rep) gets a neutral line (reason "With the Estimator for review.", no actor) for destination ESTIMATOR: Manager->Estimator reasons are internal. Always present (null = nothing to show).
   */
  returnInfo: ReturnInfo | null;
  /** Whether the Manager must accept a baseline exception to approve (Estimator-priced systems with no Cin7 SKU), and which items. Cost-entitled callers only (labels and pricing route, never a value). */
  baselineException?: BaselineExceptionView;
  /** NQ-008A. The indicative price handed off versus the price now. Cost-entitled viewers only (never in a Rep payload); null when not applicable. */
  indicativeComparison?: IndicativeComparison;
  /** SERVER-derived: true only for a quotation created in POC Presentation Mode on the NewQuip POC deployment. The page then leaves out cost / mapping diagnostics and exception forms (the server records them with the POC reason). */
  poc?: boolean;
}

async function view(db: ReturnType<typeof createServiceRoleClient>, quote: QuoteRecord, a: Actor): Promise<QuoteView> {
  const canViewCommercials = a.canSeeCost;
  let costing: QuoteView["costing"];
  let baselineException: QuoteView["baselineException"];
  if (canViewCommercials) {
    // Only an open quotation can need one; once approved the exception (if any) is read from the sealed baseline.
    if (quote.state === "ESTIMATOR_REVIEW") { try { baselineException = await baselineExceptionOf(db, a.orgId, quote.draft, evaluationContext(true)); } catch { baselineException = undefined; } }
    try { const c = await costingOf(db, a.orgId, quote.draft, evaluationContext(true)); costing = { complete: c.complete, reason: c.reasons[0] ?? null, ...(c.acceptedIncomplete ? { acceptedIncomplete: c.acceptedIncomplete } : {}) }; } catch { costing = undefined; }
  }
  const evaluation = redactEvaluationFinancials(evaluateDraft(quote.draft, evaluationContext(!canViewCommercials)), canViewCommercials);
  const open = quote.state !== "MANAGER_APPROVED_FINAL";
  let indicativeComparison: IndicativeComparison | undefined;
  if (canViewCommercials && open && (quote.customer_confirmed_cents != null || quote.revision > 1)) {
    try {
      const snaps = await allIndicativeSnapshots(db, a.orgId, quote.id);
      const last = snaps[snaps.length - 1] ?? null;
      indicativeComparison = compareToIndicative({
        snapshot: last?.snapshot ?? null, snapshotCapturedAt: last?.created_at ?? null, snapshotCapturedBy: last?.captured_by_email ?? null,
        confirmedCents: quote.customer_confirmed_cents, confirmedAt: quote.customer_confirmed_at, confirmedBy: quote.handoff_by_email,
        revision: last?.revision ?? quote.revision, draft: quote.draft, currentEvaluation: evaluation,
        history: snaps.map((s) => ({ seq: s.seq, revision: s.revision, capturedAt: s.created_at, capturedBy: s.captured_by_email, totalCents: s.total_ex_vat_cents, completeness: s.completeness })),
      });
    } catch { indicativeComparison = undefined; }
  }
  return {
    quote: redactInternalFinancials(quote, canViewCommercials),
    evaluation,
    ...(indicativeComparison ? { indicativeComparison } : {}),
    viewer: { roles: [...a.roles], canViewCommercials, previewTools: process.env.VERCEL_ENV === "preview" },
    ...(isPocQuote(quote.draft) && pocPresentationEnabled(process.env as Record<string, string | undefined>, a.orgId) ? { poc: true } : {}),
    ...(costing ? { costing } : {}),
    returnInfo: returnInfoForViewer(await returnInfoOf(db, quote.org_id, quote), canViewCommercials),
    ...(baselineException ? { baselineException } : {}),
  };
}

export async function getGrowerViewerAction(): Promise<GrowerActionResult<{ roles: QuoteRole[]; canViewCommercials: boolean }>> {
  try {
    const a = await authorise();
    return { ok: true, data: { roles: [...a.roles], canViewCommercials: a.canSeeCost } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function listGrowerQuotesAction(): Promise<GrowerActionResult<Array<Pick<QuoteRecord, "id" | "quote_ref" | "revision" | "customer_name" | "site_name" | "state" | "contract_cents" | "project_id" | "created_at"> & { signed_off: boolean }>>> {
  try {
    const a = await authorise();
    const rows = await listQuotes(createServiceRoleClient(), a.orgId);
    return { ok: true, data: rows.map((q) => ({ id: q.id, quote_ref: q.quote_ref, revision: q.revision, customer_name: q.customer_name, site_name: q.site_name, state: q.state, contract_cents: q.contract_cents, project_id: q.project_id, created_at: q.created_at, signed_off: !!q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash })) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/**
 * Everything in a submitted draft that only an Estimator or Manager may decide, or that the server owns, is checked/stamped HERE, for every route that stores a
 * client-supplied draft (create AND save): optional-element product mappings (trimmed, authorised, verified against this organisation's active catalogue),
 * manual quotation prices (authorised, provenance stamped by the server) and the cost fields (stamped / server-owned). `prior` is the stored draft, if any.
 */
async function sanitiseSubmittedDraft(a: Actor, db: ReturnType<typeof createServiceRoleClient>, draft: QuoteDraft, prior: QuoteDraft | undefined, at?: { state: QuoteRecord["state"]; revision: number }): Promise<QuoteDraft> {
  // The live preview applies a ticked exclusion at once, so a blank reason must never be stored: saved figures would then differ from the previewed ones.
  if (blankExclusions(draft).length > 0) throw new Error("Give a reason for every exclusion before saving (it is shown to the customer and frozen at approval).");
  let d = normaliseMappings(draft);
  // Any change to any product mapping (a Rep included, on create or on save) is an Estimator/Manager decision.
  if (mappingsChanged(prior?.estimator.confirmedMappings, d.estimator.confirmedMappings) && !hasAny(a.roles, ["estimator", "manager"])) throw new Error("Only an Estimator or Manager can map a product.");
  // Only new or changed mappings are verified here, so a SKU that later goes inactive cannot block unrelated edits; sign-off re-verifies all of them.
  await verifyMappings(db, a.orgId, changedMappings(prior?.estimator.confirmedMappings, d.estimator.confirmedMappings), d.config.feederVariant);
  const nowIso = new Date().toISOString();
  d = { ...d, estimator: { ...d.estimator, priceResolutions: stampPriceResolutions(d.estimator.priceResolutions, prior?.estimator.priceResolutions, a.roles, a.email, nowIso) as QuoteDraft["estimator"]["priceResolutions"] } };
  const stamped = keepServerOwnedCostBasis(keepServerOwnedCosts(stampCostOverrides(d, prior?.estimator.costOverrides, a.canSeeCost, a.email, nowIso), prior?.estimator.physicalCosts), prior?.estimator.costBasis);
  // Last line of defence (field ownership): a caller without Estimator / Manager authority can never change an Estimator-owned field, whatever the checks above did.
  const owned = keepServerOwnedPricing(keepEstimatorOwnedFields(stamped, prior, a.roles), prior); // NQ-008B Phase 2: supplier pricing is changed only by its own action
  // NQ-008A: after the handoff, who changed each price-affecting input and when is decided HERE (never by the client) and stored in the same save.
  return stampChanges(owned, prior, { state: at?.state ?? "REP_DRAFT", revision: at?.revision ?? 1, email: a.email, nowIso });
}

export async function createGrowerQuoteAction(draft?: QuoteDraft): Promise<GrowerActionResult<{ id: string; quoteRef: string }>> {
  try {
    const a = await authorise();
    if (!a.roles.has("rep")) throw new Error("Only a rep can start a quote.");
    const db = createServiceRoleClient();
    let start = draft ? await sanitiseSubmittedDraft(a, db, draft, undefined) : emptyDraft();
    // POC Presentation Mode (Preview + switch + NewQuip organisation only): the NEW quotation is marked and seeded with the Estimator inputs the workbook cannot supply.
    if (pocPresentationEnabled(process.env as Record<string, string | undefined>, a.orgId)) start = seedPocEstimator(start, new Date().toISOString());
    const r = await createQuote(db, a.orgId, a.email, start);
    await audit(db, a, { action: "newquip.quote_created", summary: `Started NewQuip quote ${r.quoteRef} (local only; no Cin7 write)`, detail: { quoteId: r.id } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function getGrowerQuoteAction(quoteId: string): Promise<GrowerActionResult<QuoteView>> {
  try {
    const a = await authorise();
    const db = createServiceRoleClient();
    const q = await loadQuote(db, a.orgId, quoteId);
    if (!q) return { ok: false, error: "Quote not found." };
    return { ok: true, data: await view(db, q, a) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Live recalculation for the editor. WRITES NOTHING — it only evaluates the draft the browser holds. */
export async function previewGrowerDraftAction(draft: QuoteDraft): Promise<GrowerActionResult<QuoteEvaluation>> {
  try {
    const a = await authorise();
    // Read-only live preview: the same engine as Save, with a ticked-but-unexplained exclusion applied so the click shows its effect. Nothing is stored.
    return { ok: true, data: redactEvaluationFinancials(evaluateDraft(previewDraftOf(draft), evaluationContext(!a.canSeeCost)), a.canSeeCost) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/**
 * Search the synced Cin7 catalogue to map an optional additional element to a product. Read-only, org-scoped from the session, Estimator or Manager
 * authority only (a plain Rep cannot change what the quotation is built from), NewQuip organisation only.
 */
export async function searchCin7CatalogueForMappingAction(query: string): Promise<GrowerActionResult<CatalogueResult>> {
  try {
    const a = await authorise();
    if (!hasAny(a.roles, ["estimator", "manager"])) throw new Error("Only an Estimator or Manager can map a product.");
    return { ok: true, data: await searchCatalogue(createServiceRoleClient(), a.orgId, query) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function saveGrowerDraftAction(quoteId: string, draft: QuoteDraft): Promise<GrowerActionResult<QuoteView>> {
  try {
    const a = await authorise();
    const db = createServiceRoleClient();
    const prior = await loadQuote(db, a.orgId, quoteId);
    // Once the quotation has a Cin7 customer snapshot, the snapshot is the ONLY source of the customer name: a typed or edited name in the submitted draft is replaced by it.
    const snapName = (await customerFeaturesAvailable(db)) ? fieldValue((await latestSnapshot(db, a.orgId, quoteId))?.snapshot.name ?? { state: "missing" }) : null;
    const priorHash = prior?.draft_hash; // read now (D-12, #195): a store that updates the row it handed out in place must not change what "before" means
    const saved = await saveDraft(db, a.orgId, a.roles, quoteId, await sanitiseSubmittedDraft(a, db, draft, prior?.draft, prior ? { state: prior.state, revision: prior.revision } : undefined), snapName);
    // Changed content invalidates the estimator's sign-off (saveDraft clears it) and any open approval of the older content: the quote goes back to estimator review.
    // Race repair: if the customer was (re)selected while this save was in flight, the snapshot name wins - write it again from the stored draft.
    if (snapName !== null || (await customerFeaturesAvailable(db))) {
      const nowName = fieldValue((await latestSnapshot(db, a.orgId, quoteId))?.snapshot.name ?? { state: "missing" });
      if (nowName && nowName !== snapName) { const cur = await loadQuote(db, a.orgId, quoteId); if (cur) await saveDraft(db, a.orgId, a.roles, quoteId, cur.draft, nowName); }
    }
    // A change of the commercial total withdraws the customer's confirmation (one helper for every draft writer); otherwise changed content only re-syncs the approval request.
    const amount = await reconcileConfirmationAmount(db, whoOf(a), quoteId, evaluationContext(true), returnByOf(a));
    // saveDraft already withdrew an existing sign-off for the changed content, so it counts as cleared in the reported effect
    let confirmationEffect: ConfirmationEffectView | undefined = amount ? { ...amount, signoffCleared: amount.signoffCleared || saved.signoffCleared } : undefined;
    if (!amount && saved.draftHash !== priorHash) {
      // D-12 (#195): stagedAvailable is INSIDE the catch; the draft is saved, so a failed sync never fails the save. resyncApprovalsLogged still reports a sync failure to the UI.
      await (async () => {
        if (!(await stagedAvailable(db))) return;
        const err = await resyncApprovalsLogged(db, whoOf(a), quoteId, { returnedToRep: false, signoffCleared: true });
        if (err) confirmationEffect = { confirmationCleared: false, signoffCleared: saved.signoffCleared, returnedToRep: false, approvalSyncError: err };
      })().catch(() => undefined);
    }
    const q = await loadQuote(db, a.orgId, quoteId);
    return q ? { ok: true, data: { ...(await view(db, q, a)), ...(confirmationEffect ? { confirmationEffect } : {}) } } : { ok: false, error: "Quote not found." };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

async function step(
  quoteId: string,
  summary: string,
  action: string,
  run: (a: Actor, db: ReturnType<typeof createServiceRoleClient>) => Promise<void | Record<string, unknown>>,
): Promise<GrowerActionResult<QuoteView>> {
  try {
    const a = await authorise();
    const db = createServiceRoleClient();
    const extra = await run(a, db);
    await audit(db, a, { action, summary: `${summary} (local only; no Cin7 write)`, detail: { quoteId, ...(extra ?? {}) } });
    const q = await loadQuote(db, a.orgId, quoteId);
    return q ? { ok: true, data: await view(db, q, a) } : { ok: false, error: "Quote not found." };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// Workflow steps always evaluate with cost WITHHELD: nothing in a handoff, sign-off or approval needs cost.

/**
 * Rep → Estimator. Records the PRE-APPROVAL price confirmation: the customer contact who confirmed this commercial amount (ex VAT, in cents). The contact is resolved here
 * from the quotation's own Cin7 customer snapshot (the default is the quotation contact), never trusted from the browser. This is NOT the customer's acceptance of the issued
 * quotation, which is recorded separately after Manager approval and is what gates project creation.
 */
export async function sendGrowerQuoteToEstimatorAction(quoteId: string, confirmedAmountCents: number, contact: ConfirmationInput) {
  return step(quoteId, "Recorded the pre-approval price confirmation and sent a NewQuip quote to the estimator", "newquip.quote_sent_to_estimator", async (a, db) => {
    if (!a.roles.has("rep")) throw new Error("Only a Rep can record the pre-approval price confirmation.");
    const available = await customerFeaturesAvailable(db);
    const snap = available ? await latestSnapshot(db, a.orgId, quoteId) : null;
    if (available && !snap) throw new Error("Select the Cin7 customer and quotation contact in Step 1 (Customer & site) before the amount can be confirmed.");
    if (!available && contact.source !== "ALTERNATIVE") throw new Error("Customer contacts are not available yet; record the contact as an alternative contact with a reason.");
    if (snap) { const cur = await loadQuote(db, a.orgId, quoteId); if (cur) assertNameMatchesSnapshot(cur.draft.customerName, cur.customer_name, snap.snapshot); }
    const resolved = resolveConfirmationContact(snap?.snapshot ?? null, contact, { by: a.email, at: new Date().toISOString(), amountCents: confirmedAmountCents });
    // The state change is a compare-and-set, so a double submit records one handoff; the contact record is appended only after it succeeded (no duplicate rows).
    await sendToEstimator(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true), { confirmedAmountCents, confirmedBy: confirmationLabel(resolved) });
    if (snap) {
      await appendSnapshot(db, a.orgId, quoteId, { ...snap.snapshot, confirmationContact: resolved }, { email: a.email, ownerEmail: a.demo?.ownerEmail ?? null },
        `Pre-approval price confirmation contact: ${confirmationLabel(resolved)}`).catch((e) => { throw new Error(`The confirmation was recorded, but its contact record could not be saved: ${errMsg(e)}`); });
    }
    // The estimator stage opens now: the policy's named estimator (or every estimator) is notified in the app and by email.
    if (await stagedAvailable(db)) await resyncQuoteApprovals(db, ctxOf(a), quoteId);
    return { confirmationContact: { source: resolved.source, name: resolved.name, email: resolved.email, reason: resolved.reason, origin: resolved.origin }, amountCents: confirmedAmountCents, confirmedBy: a.email, deliveryContactUnchanged: snap?.snapshot.chosenContact?.email ?? null };
  });
}

export async function returnGrowerQuoteToRepAction(quoteId: string, reason: string) {
  return step(quoteId, "Returned a NewQuip quote to the rep", "newquip.quote_returned_to_rep", async (a, db) => {
    if (await stagedAvailable(db)) {
      // Staged: the reason and destination are recorded on the request that is open (estimator review or manager approval); the actor must hold that stage's role.
      await decideDocument(db, ctxOf(a), "QUOTE", quoteId, "RETURN", { reason, destination: "PREPARER" });
      return;
    }
    if (await approvalsAvailable(db)) {
      // A manager returning a submitted quote is a recorded RETURN decision (reason required); an estimator pulling it back withdraws the submission.
      if (a.roles.has("manager")) { await decideDocument(db, ctxOf(a, true), "QUOTE", quoteId, "RETURN", { reason }); return; }
      await returnToRep(db, a.orgId, a.roles, quoteId, reason, returnByOf(a));
      await withdrawPendingFor(db, ctxOf(a, false), "QUOTE", quoteId, reason).catch(() => undefined);
      return;
    }
    await returnToRep(db, a.orgId, a.roles, quoteId, reason, returnByOf(a));
  });
}

export async function signOffGrowerQuoteAction(quoteId: string) {
  return step(quoteId, "Estimator signed off a NewQuip quote", "newquip.quote_estimator_signed_off", (a, db) =>
    (async () => {
      // POC Presentation Mode: on a quotation created in the mode, an Estimator's sign-off records the standard incomplete-cost exception (labelled POC PRESENTATION, audited) instead of asking the presenter for it.
      if (a.roles.has("estimator") && pocPresentationEnabled(process.env as Record<string, string | undefined>, a.orgId)) {
        const q = await loadQuote(db, a.orgId, quoteId);
        if (q && q.state === "ESTIMATOR_REVIEW" && isPocQuote(q.draft) && !q.draft.estimator.costBasis?.incompleteAccepted) {
          const draft = structuredClone(q.draft);
          draft.estimator.costBasis = { ...(draft.estimator.costBasis ?? {}), incompleteAccepted: { reason: POC_COST_REASON, by: `${a.email} (POC PRESENTATION)`, at: new Date().toISOString() } };
          await saveDraft(db, a.orgId, rolesFor("admin"), quoteId, draft);
          await audit(db, a, { action: "newquip.poc_presentation_cost_exception", summary: "POC Presentation Mode recorded the incomplete-cost exception at sign-off (demonstration only; not commercially validated)", detail: { quoteId } });
        }
      }
      // Staged: the sign-off IS the estimator-stage decision (named assignment, role, history), and it opens the manager stage.
      if (await stagedAvailable(db)) { await decideDocument(db, ctxOf(a), "QUOTE", quoteId, "APPROVE", { stage: "ESTIMATOR" }); return "STAGED" as const; }
      await estimatorSignOff(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true));
      return "LEGACY" as const;
    })().then(async (mode) => {
      if (mode === "STAGED") return;
      // The sign-off is the submission to the approving manager: record the exact revision + digest on the Approvals dashboard.
      if (await approvalsAvailable(db)) await submitForApproval(db, ctxOf(a), "QUOTE", quoteId).catch(() => undefined);
    }));
}

/** Manager -> Estimator. The quotation and its history are kept; only the estimator's sign-off is withdrawn and must be given again on the current content. */
export async function returnGrowerQuoteToEstimatorAction(quoteId: string, reason: string) {
  return step(quoteId, "Manager returned a NewQuip quote to the estimator", "newquip.quote_returned_to_estimator", async (a, db) => {
    if (!(await stagedAvailable(db))) throw new Error("Returning a quotation to the estimator needs the roles and staged approvals migration (pending).");
    await decideDocument(db, ctxOf(a), "QUOTE", quoteId, "RETURN", { reason, destination: "ESTIMATOR", stage: "MANAGER" });
  });
}

/**
 * Manager final approval — freezes the accepted baseline.
 *
 * `baselineException` (optional) is the Manager's explicit "approve with recorded exception" for Estimator-priced systems that have no Cin7 SKU. It is an OPTION OF THIS
 * ACTION rather than a separate action that parks a pending exception, because a parked exception would need somewhere to live without a migration (the draft would change
 * its hash and withdraw the Estimator's sign-off) and could outlive the content it was recorded for. Here it is recorded, bound to the version the Manager reviewed, and sealed
 * into the baseline in ONE step; if any check fails nothing is written. Authorisation (Manager role, reason, version, "an exception really applies") is decided BEFORE the
 * approval request is touched, so a refused request causes no write at all.
 */
export async function approveGrowerQuoteAction(quoteId: string, opts?: { baselineException?: BaselineExceptionRequest }) {
  return step(quoteId, "Manager approved a NewQuip quote and froze the accepted baseline", "newquip.quote_manager_approved", async (a, db) => {
    // POC Presentation Mode: where a Manager baseline exception is REQUIRED and sufficient (M75 / penning are Estimator-priced by design), record it with the POC reason instead of asking for the form. Nothing else is waived.
    if (!opts?.baselineException && a.roles.has("manager") && pocPresentationEnabled(process.env as Record<string, string | undefined>, a.orgId)) {
      const pq = await loadQuote(db, a.orgId, quoteId);
      if (pq && pq.state === "ESTIMATOR_REVIEW" && isPocQuote(pq.draft)) {
        const need = await baselineExceptionOf(db, a.orgId, pq.draft, evaluationContext(true));
        if (need.baselineExceptionRequired) opts = { baselineException: { reason: POC_BASELINE_REASON, expectedRevision: pq.revision, expectedDraftHash: pq.draft_hash } };
      }
    }
    // A stale confirmation (confirmed contact changed, or total no longer the confirmed amount) can never be approved. Read-only; the role checks below still decide who may approve.
    if (a.roles.has("manager")) await assertConfirmationCurrent(db, a.orgId, quoteId, evaluationContext(true));
    const bx = opts?.baselineException ? { reason: String(opts.baselineException.reason ?? ""), expectedRevision: Number(opts.baselineException.expectedRevision), expectedDraftHash: String(opts.baselineException.expectedDraftHash ?? "") } : undefined;
    let recorded: { text: string; items: BaselineExceptionItem[]; reason: string; revision: number; draftHash: string } | undefined;
    if (bx) {
      if (!a.roles.has("manager")) throw new Error("Only a Manager can accept a baseline exception.");
      const bad = validateExceptionReason(bx.reason);
      if (bad) throw new Error(bad);
      const q = await loadQuote(db, a.orgId, quoteId);
      if (!q) throw new Error("Quote not found.");
      if (bx.expectedRevision !== q.revision || bx.expectedDraftHash !== q.draft_hash) throw new Error("The quotation changed after the exception was reviewed. Review the current version and accept the exception again.");
      const need = await baselineExceptionOf(db, a.orgId, q.draft, evaluationContext(true));
      if (!need.baselineExceptionRequired) throw new Error(need.otherBlockers.length ? `A baseline exception cannot cover everything still unresolved: ${need.otherBlockers[0]}` : "No baseline exception applies to this quotation.");
      recorded = { text: exceptionDecisionText({ unresolved: need.items, reason: bx.reason.trim() }), items: need.items, reason: bx.reason.trim(), revision: q.revision, draftHash: q.draft_hash };
    }
    // One approval path: when the Approvals framework is available the decision is recorded there (separation of duties, exact revision, history).
    if (await stagedAvailable(db)) await decideDocument(db, ctxOf(a), "QUOTE", quoteId, "APPROVE", { stage: "MANAGER", ...(bx ? { reason: recorded!.text, baselineException: bx } : {}) });
    else if (await approvalsAvailable(db)) await decideDocument(db, ctxOf(a, a.roles.has("manager")), "QUOTE", quoteId, "APPROVE", bx ? { reason: recorded!.text, baselineException: bx } : {});
    // Approval evaluates with cost withheld; the INTERNAL margin sheet is frozen from a second, cost-visible evaluation of the same draft.
    else await managerApprove(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true), evaluationContext(false), bx ? { baselineException: bx } : undefined);
    if (!recorded) return;
    // The exception is now sealed in the baseline. It also gets its own audit record (who, when, which version, which items, why).
    const detail = { quoteId, revision: recorded.revision, draftHash: recorded.draftHash, unresolved: recorded.items.map((i) => ({ itemKey: i.itemKey, label: i.label, pricedBy: i.pricedBy })), reason: recorded.reason, approvedBy: a.email };
    await audit(db, a, { action: "newquip.baseline_exception_accepted", summary: `Manager accepted a baseline exception (${BASELINE_EXCEPTION_TITLE}) for ${recorded.items.length} item(s) at revision ${recorded.revision} (local only; no Cin7 write)`, detail });
    return { baselineException: { items: recorded.items.map((i) => i.itemKey), reason: recorded.reason, revision: recorded.revision, draftHash: recorded.draftHash } };
  });
}

/** What the project was actually created with (read back from the database, never echoed from the request). */
export interface CreatedProjectResult { projectId: string; created: boolean; billingSchedule: string | null; stages: Array<{ name: string; valueCents: number }> }

export async function createProjectFromGrowerQuoteAction(quoteId: string, scheduleChoice?: ScheduleChoice): Promise<GrowerActionResult<CreatedProjectResult>> {
  try {
    const a = await authorise();
    if (!hasAny(a.roles, PROJECT_CREATE_ROLES)) throw new Error("Only a Manager can create a Project from an accepted quotation.");
    const db = createServiceRoleClient();
    const applied = await resolveProjectSchedule(db, a.orgId, scheduleChoice);
    const resolved = { schedule: applied.schedule, label: applied.label };
    const r = await createProjectFromAcceptedQuote(db, a.orgId, a.email, quoteId, resolved.schedule, applied.source);
    if (r.created) await audit(db, a, { action: "newquip.project_created", summary: "Created a Project from an accepted NewQuip quote (local only; no Cin7 write)", detail: { quoteId, projectId: r.projectId, billingSchedule: resolved.label, stages: resolved.schedule.map((x) => `${x.name} ${(x.bps / 100).toFixed(2)}%`) } });
    const persisted = await db.from("project_stages").select("name, value_cents, sort_order").eq("org_id", a.orgId).eq("project_id", r.projectId).order("sort_order", { ascending: true });
    if (persisted.error) throw new Error(persisted.error.message);
    const stages = ((persisted.data ?? []) as Array<{ name: string; value_cents: number }>).map((x) => ({ name: x.name, valueCents: x.value_cents }));
    return { ok: true, data: { ...r, billingSchedule: r.created ? resolved.label : null, stages } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
