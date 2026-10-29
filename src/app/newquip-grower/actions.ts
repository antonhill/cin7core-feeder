"use server";

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { evaluateDraft, type QuoteEvaluation } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { type OrgTier, type QuoteRole } from "@/newquip/quote/roles";
import { toQuoteRoles } from "@/lib/approvals/roles";
import { canSeeCosts, resolveRoles } from "@/lib/approvals/role-store";
import { demoAuditDetail, resolveActing, type DemoInfo } from "@/lib/demo-mode/context";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { keepServerOwnedCostBasis, keepServerOwnedCosts, redactInternalFinancials, stampCostOverrides } from "@/newquip/quote/margin";
import { approvalsAvailable, decideDocument, legacyCtx, resyncQuoteApprovals, stagedAvailable, submitForApproval, withdrawPendingFor } from "@/lib/approvals/approval-store";
import type { ScheduleChoice } from "@/newquip/quote/billing-schedule";
import { resolveProjectSchedule } from "@/lib/newquip-quotes/schedule-resolve";
import {
  createProjectFromAcceptedQuote, createQuote, estimatorSignOff, listQuotes, loadQuote, managerApprove, returnToRep, saveDraft, sendToEstimator,
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

/** The audit record of any action: the REAL owner is the actor, the effective user and the DEMO marker are in the detail. */
async function audit(db: ReturnType<typeof createServiceRoleClient>, a: Actor, i: { action: string; summary: string; detail: Record<string, unknown> }) {
  await logActivity(db, a.demo
    ? { orgId: a.orgId, actor: { userId: a.demo.ownerUserId, email: a.demo.ownerEmail }, action: i.action, summary: `[DEMO] ${i.summary}`, detail: demoAuditDetail(a.demo, i.detail) }
    : { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: i.action, summary: i.summary, detail: i.detail });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : "Unknown error";
}

/** A quote as the browser sees it: the record plus the viewer's roles. No cost ever travels in `evaluation` for non-admins. */
export interface QuoteView {
  quote: QuoteRecord;
  evaluation: QuoteEvaluation;
  viewer: { roles: QuoteRole[]; canViewCommercials: boolean };
}

function view(quote: QuoteRecord, a: Actor): QuoteView {
  const canViewCommercials = a.canSeeCost;
  return {
    quote: redactInternalFinancials(quote, canViewCommercials),
    evaluation: evaluateDraft(quote.draft, evaluationContext(!canViewCommercials)),
    viewer: { roles: [...a.roles], canViewCommercials },
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

export async function listGrowerQuotesAction(): Promise<GrowerActionResult<Array<Pick<QuoteRecord, "id" | "quote_ref" | "revision" | "customer_name" | "site_name" | "state" | "contract_cents" | "project_id" | "created_at">>>> {
  try {
    const a = await authorise();
    const rows = await listQuotes(createServiceRoleClient(), a.orgId);
    return { ok: true, data: rows.map((q) => ({ id: q.id, quote_ref: q.quote_ref, revision: q.revision, customer_name: q.customer_name, site_name: q.site_name, state: q.state, contract_cents: q.contract_cents, project_id: q.project_id, created_at: q.created_at })) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function createGrowerQuoteAction(draft?: QuoteDraft): Promise<GrowerActionResult<{ id: string; quoteRef: string }>> {
  try {
    const a = await authorise();
    if (!a.roles.has("rep")) throw new Error("Only a rep can start a quote.");
    const db = createServiceRoleClient();
    const r = await createQuote(db, a.orgId, a.email, draft);
    await audit(db, a, { action: "newquip.quote_created", summary: `Started NewQuip quote ${r.quoteRef} (local only; no Cin7 write)`, detail: { quoteId: r.id } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function getGrowerQuoteAction(quoteId: string): Promise<GrowerActionResult<QuoteView>> {
  try {
    const a = await authorise();
    const q = await loadQuote(createServiceRoleClient(), a.orgId, quoteId);
    if (!q) return { ok: false, error: "Quote not found." };
    return { ok: true, data: view(q, a) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

/** Live recalculation for the editor. WRITES NOTHING — it only evaluates the draft the browser holds. */
export async function previewGrowerDraftAction(draft: QuoteDraft): Promise<GrowerActionResult<QuoteEvaluation>> {
  try {
    const a = await authorise();
    return { ok: true, data: evaluateDraft(draft, evaluationContext(!a.canSeeCost)) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function saveGrowerDraftAction(quoteId: string, draft: QuoteDraft): Promise<GrowerActionResult<QuoteView>> {
  try {
    const a = await authorise();
    const db = createServiceRoleClient();
    const prior = await loadQuote(db, a.orgId, quoteId);
    const saved = await saveDraft(db, a.orgId, a.roles, quoteId, keepServerOwnedCostBasis(keepServerOwnedCosts(stampCostOverrides(draft, prior?.draft.estimator.costOverrides, a.canSeeCost, a.email, new Date().toISOString()), prior?.draft.estimator.physicalCosts), prior?.draft.estimator.costBasis));
    // Changed content invalidates the estimator's sign-off (saveDraft clears it) and any open approval of the older content: the quote goes back to estimator review.
    if (saved.draftHash !== prior?.draft_hash && (await stagedAvailable(db))) await resyncQuoteApprovals(db, ctxOf(a), quoteId, { quiet: true }).catch(() => undefined);
    const q = await loadQuote(db, a.orgId, quoteId);
    return q ? { ok: true, data: view(q, a) } : { ok: false, error: "Quote not found." };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

async function step(
  quoteId: string,
  summary: string,
  action: string,
  run: (a: Actor, db: ReturnType<typeof createServiceRoleClient>) => Promise<void>,
): Promise<GrowerActionResult<QuoteView>> {
  try {
    const a = await authorise();
    const db = createServiceRoleClient();
    await run(a, db);
    await audit(db, a, { action, summary: `${summary} (local only; no Cin7 write)`, detail: { quoteId } });
    const q = await loadQuote(db, a.orgId, quoteId);
    return q ? { ok: true, data: view(q, a) } : { ok: false, error: "Quote not found." };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

// Workflow steps always evaluate with cost WITHHELD: nothing in a handoff, sign-off or approval needs cost.

/** Rep → Estimator. Records that the customer confirmed this commercial amount (ex VAT, in cents). */
export async function sendGrowerQuoteToEstimatorAction(quoteId: string, confirmedAmountCents: number, confirmedBy: string) {
  return step(quoteId, "Sent a NewQuip quote to the estimator (customer confirmed the amount)", "newquip.quote_sent_to_estimator", (a, db) =>
    sendToEstimator(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true), { confirmedAmountCents, confirmedBy }).then(async () => {
      // The estimator stage opens now: the policy's named estimator (or every estimator) is notified in the app and by email.
      if (await stagedAvailable(db)) await resyncQuoteApprovals(db, ctxOf(a), quoteId);
    }));
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
      await returnToRep(db, a.orgId, a.roles, quoteId, reason);
      await withdrawPendingFor(db, ctxOf(a, false), "QUOTE", quoteId, reason).catch(() => undefined);
      return;
    }
    await returnToRep(db, a.orgId, a.roles, quoteId, reason);
  });
}

export async function signOffGrowerQuoteAction(quoteId: string) {
  return step(quoteId, "Estimator signed off a NewQuip quote", "newquip.quote_estimator_signed_off", (a, db) =>
    (async () => {
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

/** Manager final approval — freezes the accepted baseline. */
export async function approveGrowerQuoteAction(quoteId: string) {
  return step(quoteId, "Manager approved a NewQuip quote and froze the accepted baseline", "newquip.quote_manager_approved", async (a, db) => {
    // One approval path: when the Approvals framework is available the decision is recorded there (separation of duties, exact revision, history).
    if (await stagedAvailable(db)) { await decideDocument(db, ctxOf(a), "QUOTE", quoteId, "APPROVE", { stage: "MANAGER" }); return; }
    if (await approvalsAvailable(db)) { await decideDocument(db, ctxOf(a, a.roles.has("manager")), "QUOTE", quoteId, "APPROVE"); return; }
    // Approval evaluates with cost withheld; the INTERNAL margin sheet is frozen from a second, cost-visible evaluation of the same draft.
    await managerApprove(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true), evaluationContext(false));
  });
}

/** What the project was actually created with (read back from the database, never echoed from the request). */
export interface CreatedProjectResult { projectId: string; created: boolean; billingSchedule: string | null; stages: Array<{ name: string; valueCents: number }> }

export async function createProjectFromGrowerQuoteAction(quoteId: string, scheduleChoice?: ScheduleChoice): Promise<GrowerActionResult<CreatedProjectResult>> {
  try {
    const a = await authorise();
    if (!a.roles.has("manager") && !a.roles.has("estimator")) throw new Error("You do not have permission to create a Project.");
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
