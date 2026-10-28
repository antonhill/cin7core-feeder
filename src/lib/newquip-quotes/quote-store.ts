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
import { authoriseTransition, canEditDraft, checkApproval, checkHandoff, type QuoteState } from "@/newquip/quote/workflow";
import type { QuoteRole } from "@/newquip/quote/roles";
import { createProjectFromBaseline } from "@/lib/projects/project-store";

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
  const { baseline, hash } = buildAcceptedBaseline({
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
export async function createProjectFromAcceptedQuote(db: Db, orgId: string, email: string, quoteId: string, schedule?: readonly ScheduleStageTemplate[]): Promise<{ projectId: string; created: boolean }> {
  const q = await mustLoad(db, orgId, quoteId);
  if (q.state !== "MANAGER_APPROVED_FINAL" || !q.accepted_baseline || !q.baseline_hash) fail("Only a manager-approved final quote can become a Project.");
  if (q.project_id) return { projectId: q.project_id, created: false };
  if (!baselineMatchesHash(q.accepted_baseline, q.baseline_hash)) fail("The accepted baseline no longer matches its seal; refusing to create a Project.");

  // Variation billing projects (migration 0105) copy originating_quote_ref from their parent, so this lookup must pick the BASE project only:
  // matching a child would link the quote to an internal billing project. Filtered in code so it also works before 0105 exists.
  const found = await db.from("projects").select("*").eq("org_id", orgId).eq("originating_quote_ref", q.quote_ref);
  if (found.error) fail(found.error.message);
  const bases = ((found.data ?? []) as Array<{ id: string; parent_project_id?: string | null; billing_scope?: string | null }>).filter((p) => !p.parent_project_id && p.billing_scope !== "VARIATION");
  if (bases.length > 1) fail("More than one project exists for this quote; refusing to guess which one to link.");
  let projectId = bases[0]?.id ?? null;
  const created = projectId == null;
  if (!projectId) {
    const generic = quoteToProjectBaseline(q.accepted_baseline, q.baseline_hash, q.id, schedule);
    projectId = await createProjectFromBaseline(db, orgId, email, generic, { reference: `PRJ-${q.quote_ref}`, name: `${q.accepted_baseline.quote.customerName} — ${q.accepted_baseline.quote.siteName}` });
  }
  const link = await db.from("newquip_quotes").update({ project_id: projectId }).eq("org_id", orgId).eq("id", quoteId).eq("state", "MANAGER_APPROVED_FINAL").select("id");
  if (link.error) fail(link.error.message);
  if (!link.data || link.data.length === 0) fail("The project was created but could not be linked to the quote.");
  return { projectId, created };
}
