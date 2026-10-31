import "server-only";
// NewQuip quotes — persistence orchestration. LOCAL ONLY: this module imports nothing from src/cin7 and never calls fetch
// (pinned by no-cin7-write.test.ts). Every query is scoped by org_id; a quote of another org is indistinguishable from "not
// found". Authorisation is decided by the caller (the Server Action) and passed in as the actor's ROLES; each step here
// re-checks the role against the workflow table, so the workflow can never be driven by a caller that lacks the role.
import type { createServiceRoleClient } from "@/supabase/server";
import { evaluateDraft, type EvaluationContext, type QuoteEvaluation } from "@/newquip/grower/evaluate";
import { emptyDraft, type QuoteDraft } from "@/newquip/grower/draft";
import { buildAcceptedBaseline, baselineMatchesHash, hashOf, type AcceptedBaseline } from "@/newquip/quote/baseline";
import { quoteToProjectBaseline } from "@/newquip/quote/to-project";
import type { ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import type { ScheduleSource } from "@/newquip/quote/project-template";
import { authoriseTransition, canEditDraft, checkApproval, checkHandoff, type QuoteState } from "@/newquip/quote/workflow";
import type { QuoteRole } from "@/newquip/quote/roles";
import { createProjectFromBaseline } from "@/lib/projects/project-store";
import { libraryOf, listActiveMappings } from "@/lib/projects/package-mapping-store";
import { requireAcceptance } from "./acceptance";
import { latestSnapshot } from "./customer-store";

type Db = ReturnType<typeof createServiceRoleClient>;

function fail(message: string): never {
  throw new Error(message);
}

export interface QuoteRecord {
  id: string;
  org_id: string;
  quote_ref: string;
  revision: number;
  customer_name: string;
  site_name: string;
  quote_type: "day_to_day" | "project";
  state: QuoteState;
  draft: QuoteDraft;
  draft_hash: string;
  customer_confirmed_cents: number | null;
  customer_confirmed_by: string | null;
  customer_confirmed_at: string | null;
  handoff_by_email: string | null;
  estimator_signoff_hash: string | null;
  estimator_signoff_by_email: string | null;
  estimator_signoff_at: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  accepted_baseline: AcceptedBaseline | null;
  baseline_hash: string | null;
  contract_cents: number | null;
  project_id: string | null;
  /** Migration 0115. TRUE: a Project needs the customer's acceptance of the issued quotation. FALSE / absent: grandfathered (existed before 0115). */
  requires_customer_acceptance?: boolean | null;
  created_by_email: string | null;
  created_at: string;
  updated_at: string;
}

const totalCents = (ev: QuoteEvaluation): number | null => (ev.budget && !ev.budget.incomplete ? Math.round(ev.budget.totals.subtotalExTax * 100) : null);

// ── reads ───────────────────────────────────────────────────────────────────

export async function loadQuote(db: Db, orgId: string, quoteId: string): Promise<QuoteRecord | null> {
  const r = await db.from("newquip_quotes").select("*").eq("org_id", orgId).eq("id", quoteId).maybeSingle();
  if (r.error) fail(`load quote: ${r.error.message}`);
  return (r.data as QuoteRecord | null) ?? null;
}

export async function listQuotes(db: Db, orgId: string): Promise<QuoteRecord[]> {
  const r = await db.from("newquip_quotes").select("*").eq("org_id", orgId).order("created_at", { ascending: false });
  if (r.error) fail(`list quotes: ${r.error.message}`);
  return (r.data ?? []) as QuoteRecord[];
}

async function mustLoad(db: Db, orgId: string, quoteId: string): Promise<QuoteRecord> {
  return (await loadQuote(db, orgId, quoteId)) ?? fail("Quote not found.");
}

// ── drafting ────────────────────────────────────────────────────────────────

export async function createQuote(db: Db, orgId: string, email: string, draft: QuoteDraft = emptyDraft()): Promise<{ id: string; quoteRef: string }> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = await db.from("newquip_quotes").select("quote_ref").eq("org_id", orgId);
    if (existing.error) fail(existing.error.message);
    const max = ((existing.data ?? []) as { quote_ref: string }[]).reduce((m, q) => Math.max(m, Number(/(\d+)$/.exec(q.quote_ref)?.[1] ?? 0)), 0);
    const quoteRef = `NQ-Q-${String(max + 1 + attempt).padStart(4, "0")}`;
    const ins = await db.from("newquip_quotes").insert({
      org_id: orgId, quote_ref: quoteRef, state: "REP_DRAFT", revision: 1, customer_name: draft.customerName, site_name: draft.siteName, quote_type: draft.quoteType,
      draft, draft_hash: hashOf(draft), created_by_email: email,
    }).select("id").single();
    if (!ins.error && ins.data) return { id: (ins.data as { id: string }).id, quoteRef };
    if (!/duplicate key|unique/i.test(ins.error?.message ?? "")) fail(`create quote: ${ins.error?.message ?? "no row"}`);
  }
  return fail("Could not allocate a quote reference; try again.");
}

/**
 * Saves the editable draft. An edit made after the estimator signed off CLEARS the sign-off (it covered different content).
 * An approved quote is never editable.
 */
export async function saveDraft(db: Db, orgId: string, roles: ReadonlySet<QuoteRole>, quoteId: string, draft: QuoteDraft): Promise<{ draftHash: string; signoffCleared: boolean }> {
  const q = await mustLoad(db, orgId, quoteId);
  if (!canEditDraft(roles, q.state)) fail(q.state === "MANAGER_APPROVED_FINAL" ? "The accepted quote is final and cannot be edited. Post-acceptance changes must be Variations." : "You do not have permission to edit this quote.");
  const draftHash = hashOf(draft);
  const changed = draftHash !== q.draft_hash;
  const clearSignoff = changed && q.estimator_signoff_hash != null;
  const r = await db.from("newquip_quotes").update({
    draft, draft_hash: draftHash, customer_name: draft.customerName, site_name: draft.siteName, quote_type: draft.quoteType,
    ...(clearSignoff ? { estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null } : {}),
  }).eq("org_id", orgId).eq("id", quoteId).in("state", ["REP_DRAFT", "ESTIMATOR_REVIEW"]).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The quote could not be saved (its state changed).");
  return { draftHash, signoffCleared: clearSignoff };
}

/**
 * The customer on an EDITABLE quotation changed (or was cleared). Only the customer name is rewritten: scope, packages and pricing are untouched. Anything that was
 * given for the PREVIOUS customer no longer applies: the estimator's sign-off is withdrawn and, in estimator review, the customer's confirmed amount is cleared and the
 * quotation goes back to the Rep as a new revision (so the new customer must confirm before it is handed off again). A REP_DRAFT has no confirmation yet.
 */
export async function applyCustomerChange(
  db: Db, orgId: string, quoteId: string, customerName: string, previousCustomer: boolean,
): Promise<{ returnedToRep: boolean; signoffCleared: boolean; confirmationCleared: boolean }> {
  const q = await mustLoad(db, orgId, quoteId);
  if (q.state === "MANAGER_APPROVED_FINAL") fail("The customer details of an approved quotation are immutable. Start a new quotation for a different customer.");
  // First Cin7 selection that merely confirms the customer already named on the quotation: nothing given for a different customer, so nothing to withdraw.
  if (!previousCustomer && (q.customer_name ?? "").trim() === customerName.trim()) return { returnedToRep: false, signoffCleared: false, confirmationCleared: false };
  const draft = { ...q.draft, customerName } as QuoteDraft;
  const inReview = q.state === "ESTIMATOR_REVIEW";
  const signoffCleared = q.estimator_signoff_hash != null;
  const confirmationCleared = q.customer_confirmed_cents != null || q.customer_confirmed_by != null;
  const r = await db.from("newquip_quotes").update({
    draft, draft_hash: hashOf(draft), customer_name: customerName,
    estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
    ...(inReview ? { state: "REP_DRAFT", revision: q.revision + 1, customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null } : {}),
  }).eq("org_id", orgId).eq("id", quoteId).eq("state", q.state).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The quotation changed while updating the customer; refresh and try again.");
  return { returnedToRep: inReview, signoffCleared, confirmationCleared };
}

// ── workflow ────────────────────────────────────────────────────────────────

/** Rep → Estimator. Records the customer's confirmation of the commercial amount. */
export async function sendToEstimator(
  db: Db, orgId: string, roles: ReadonlySet<QuoteRole>, email: string, quoteId: string, ctx: EvaluationContext,
  input: { confirmedAmountCents: number; confirmedBy: string },
): Promise<void> {
  const q = await mustLoad(db, orgId, quoteId);
  const auth = authoriseTransition(roles, q.state, "SEND_TO_ESTIMATOR");
  if (!auth.ok) fail(auth.error);
  const ev = evaluateDraft(q.draft, ctx);
  const chk = checkHandoff({ readiness: ev.readiness, totalExVatCents: totalCents(ev), confirmedAmountCents: input.confirmedAmountCents, confirmedBy: input.confirmedBy });
  if (!chk.ok) fail(chk.error);
  const r = await db.from("newquip_quotes").update({
    state: auth.to, customer_confirmed_cents: input.confirmedAmountCents, customer_confirmed_by: input.confirmedBy.trim(),
    customer_confirmed_at: new Date().toISOString(), handoff_by_email: email,
    estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
  }).eq("org_id", orgId).eq("id", quoteId).eq("state", "REP_DRAFT").eq("draft_hash", q.draft_hash).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The quote changed while sending; refresh and try again.");
}

/** Estimator → Rep: a new revision. The customer's confirmation and any sign-off no longer apply. */
export async function returnToRep(db: Db, orgId: string, roles: ReadonlySet<QuoteRole>, quoteId: string, reason: string): Promise<void> {
  if (!reason.trim()) fail("A reason is required to return a quote to the rep.");
  const q = await mustLoad(db, orgId, quoteId);
  const auth = authoriseTransition(roles, q.state, "RETURN_TO_REP");
  if (!auth.ok) fail(auth.error);
  const r = await db.from("newquip_quotes").update({
    state: auth.to, revision: q.revision + 1, customer_confirmed_cents: null, customer_confirmed_by: null, customer_confirmed_at: null, handoff_by_email: null,
    estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null,
  }).eq("org_id", orgId).eq("id", quoteId).eq("state", "ESTIMATOR_REVIEW").select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The quote is no longer in estimator review.");
}

/**
 * Manager -> Estimator. The quotation, its revision, the customer's confirmation and its whole history are kept; ONLY the estimator's sign-off is
 * withdrawn, so it cannot be approved again until an estimator signs off the (possibly corrected) current content.
 */
export async function returnToEstimator(db: Db, orgId: string, roles: ReadonlySet<QuoteRole>, quoteId: string, reason: string): Promise<void> {
  if (!reason.trim()) fail("A reason is required to return a quote to the estimator.");
  const q = await mustLoad(db, orgId, quoteId);
  const auth = authoriseTransition(roles, q.state, "RETURN_TO_ESTIMATOR");
  if (!auth.ok) fail(auth.error);
  if (!q.estimator_signoff_hash) fail("The estimator has not signed this quote off, so there is nothing to return to the estimator.");
  const r = await db.from("newquip_quotes").update({ estimator_signoff_hash: null, estimator_signoff_by_email: null, estimator_signoff_at: null })
    .eq("org_id", orgId).eq("id", quoteId).eq("state", "ESTIMATOR_REVIEW").eq("draft_hash", q.draft_hash).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The quote changed while returning it; refresh and try again.");
}

/** The estimator double-checked THIS exact content (its hash is what is recorded). */
export async function estimatorSignOff(db: Db, orgId: string, roles: ReadonlySet<QuoteRole>, email: string, quoteId: string, ctx: EvaluationContext): Promise<void> {
  const q = await mustLoad(db, orgId, quoteId);
  const auth = authoriseTransition(roles, q.state, "ESTIMATOR_SIGN_OFF");
  if (!auth.ok) fail(auth.error);
  const ev = evaluateDraft(q.draft, ctx);
  if (ev.readiness.state !== "READY") fail(`The quote is ${ev.readiness.state}; resolve ${ev.readiness.reasons[0] ?? "the outstanding items"} before signing off.`);
  const r = await db.from("newquip_quotes").update({ estimator_signoff_hash: q.draft_hash, estimator_signoff_by_email: email, estimator_signoff_at: new Date().toISOString() })
    .eq("org_id", orgId).eq("id", quoteId).eq("state", "ESTIMATOR_REVIEW").eq("draft_hash", q.draft_hash).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The quote changed while signing off; refresh and try again.");
}

/**
 * Manager final approval. Re-evaluates the saved draft SERVER-SIDE (no client number is ever trusted), verifies every
 * precondition, builds the sealed baseline and freezes it. Creates nothing in Cin7.
 */
export async function managerApprove(db: Db, orgId: string, roles: ReadonlySet<QuoteRole>, email: string, quoteId: string, ctx: EvaluationContext, marginCtx?: EvaluationContext): Promise<{ baselineHash: string; contractCents: number }> {
  const q = await mustLoad(db, orgId, quoteId);
  const auth = authoriseTransition(roles, q.state, "MANAGER_APPROVE");
  if (!auth.ok) fail(auth.error);
  const ev = evaluateDraft(q.draft, ctx);
  const chk = checkApproval({ readiness: ev.readiness, totalExVatCents: totalCents(ev), customerConfirmedCents: q.customer_confirmed_cents, signoffHash: q.estimator_signoff_hash, currentDraftHash: q.draft_hash });
  if (!chk.ok) fail(chk.error);
  const now = new Date().toISOString();
  // Reusable mappings active RIGHT NOW are applied to unmapped packages and sealed with their versions. Unresolved items never block approval.
  const library = await listActiveMappings(db, orgId);
  const { baseline, hash } = buildAcceptedBaseline({
    mappingLibrary: library ? libraryOf(library) : undefined,
    quoteRef: q.quote_ref, revision: q.revision, draft: q.draft, evaluation: ev,
    // Cost-visible evaluation of the SAME draft, used only for the internal margin sheet frozen with the baseline.
    marginEvaluation: marginCtx ? evaluateDraft(q.draft, marginCtx) : undefined,
    approvals: {
      customerConfirmedAt: q.customer_confirmed_at ?? now, customerConfirmedCents: q.customer_confirmed_cents!, customerConfirmedBy: q.customer_confirmed_by ?? "",
      handoffBy: q.handoff_by_email ?? "", estimatorSignoffBy: q.estimator_signoff_by_email ?? "", estimatorSignoffAt: q.estimator_signoff_at ?? now,
      managerApprovedBy: email, managerApprovedAt: now,
    },
  });
  const r = await db.from("newquip_quotes").update({
    state: auth.to, accepted_baseline: baseline, baseline_hash: hash, contract_cents: baseline.contractCents, approved_by_email: email, approved_at: now,
  }).eq("org_id", orgId).eq("id", quoteId).eq("state", "ESTIMATOR_REVIEW").eq("draft_hash", q.draft_hash).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data || r.data.length === 0) fail("The quote changed during approval; refresh and review it again.");
  return { baselineHash: hash, contractCents: baseline.contractCents };
}

// ── Quote → Project ─────────────────────────────────────────────────────────

/**
 * Creates the Project from the ACCEPTED baseline only. Verifies the stored baseline still matches its seal, performs NO
 * engineering recalculation, and is idempotent: a quote that already has a project returns it (and a project created but not
 * yet linked — e.g. after a crash — is found by its quote reference and linked rather than duplicated).
 */
export async function createProjectFromAcceptedQuote(db: Db, orgId: string, email: string, quoteId: string, schedule?: readonly ScheduleStageTemplate[], scheduleSource?: ScheduleSource): Promise<{ projectId: string; created: boolean }> {
  const q = await mustLoad(db, orgId, quoteId);
  if (q.state !== "MANAGER_APPROVED_FINAL" || !q.accepted_baseline || !q.baseline_hash) fail("Only a manager-approved final quote can become a Project.");
  if (q.project_id) return { projectId: q.project_id, created: false };
  if (!baselineMatchesHash(q.accepted_baseline, q.baseline_hash)) fail("The accepted baseline no longer matches its seal; refusing to create a Project.");

  // Variation billing projects (migration 0105) copy originating_quote_ref from their parent, so this lookup must pick the BASE project only:
  // matching a child would link the quote to an internal billing project. Filtered in code so it also works before 0105 exists.
  const findBases = async () => {
    const found = await db.from("projects").select("*").eq("org_id", orgId).eq("originating_quote_ref", q.quote_ref);
    if (found.error) fail(found.error.message);
    const bases = ((found.data ?? []) as Array<{ id: string; parent_project_id?: string | null; billing_scope?: string | null }>).filter((p) => !p.parent_project_id && p.billing_scope !== "VARIATION");
    if (bases.length > 1) fail("More than one project exists for this quote; refusing to guess which one to link.");
    return bases;
  };
  const linkProject = async (id: string, wasCreated: boolean): Promise<{ projectId: string; created: boolean }> => {
    const link = await db.from("newquip_quotes").update({ project_id: id }).eq("org_id", orgId).eq("id", quoteId).eq("state", "MANAGER_APPROVED_FINAL").select("id");
    if (link.error) fail(link.error.message);
    if (!link.data || link.data.length === 0) fail("The project was created but could not be linked to the quote.");
    return { projectId: id, created: wasCreated };
  };
  let projectId = (await findBases())[0]?.id ?? null;
  const created = projectId == null;
  if (!projectId) {
    // Quotations created after migration 0115 need the customer's acceptance of the CURRENT issued document, and the Project takes the billing schedule the customer
    // accepted. Quotations that existed at the cutover are grandfathered (null) and behave exactly as before.
    const accepted = await requireAcceptance(db, orgId, q);
    const snap = await latestSnapshot(db, orgId, q.id);
    let generic = quoteToProjectBaseline(q.accepted_baseline, q.baseline_hash, q.id, accepted ? accepted.schedule : schedule, accepted ? (accepted.scheduleSource ?? scheduleSource) : scheduleSource);
    if (snap) generic = { ...generic, customer: { ...generic.customer, cin7CustomerId: snap.cin7_customer_id } }; // the selected Cin7 customer, by its authoritative ID
    try {
      projectId = await createProjectFromBaseline(db, orgId, email, generic, { reference: `PRJ-${q.quote_ref}`, name: `${q.accepted_baseline.quote.customerName} — ${q.accepted_baseline.quote.siteName}` });
    } catch (e) {
      // A concurrent request (double click, two tabs, a reload mid-request) may have created it first: the project reference is unique per organisation, so the loser is refused by the database. Link the existing one; never create a second.
      const winner = /duplicate key|unique constraint|23505/i.test(e instanceof Error ? e.message : String(e)) ? ((await findBases())[0]?.id ?? null) : null;
      if (!winner) throw e;
      projectId = winner;
      return await linkProject(winner, false);
    }
  }
  return await linkProject(projectId, created);
}
