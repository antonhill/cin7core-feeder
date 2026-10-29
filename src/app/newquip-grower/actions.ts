"use server";

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { QUOTES_MODULE } from "@/app/module-nav";
import { requireNewquipPocOrg } from "@/newquip/require-newquip-poc-org";
import { evaluateDraft, type QuoteEvaluation } from "@/newquip/grower/evaluate";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { rolesFor, type OrgTier, type QuoteRole } from "@/newquip/quote/roles";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { redactInternalFinancials, stampCostOverrides } from "@/newquip/quote/margin";
import { approvalsAvailable, decideDocument, legacyCtx, submitForApproval, withdrawPendingFor } from "@/lib/approvals/approval-store";
import { resolveScheduleChoice, type ScheduleChoice, type ScheduleStageTemplate } from "@/newquip/quote/billing-schedule";
import { sameSchedule, type ScheduleSource } from "@/newquip/quote/project-template";
import { loadActiveTemplateVersion } from "@/lib/projects/project-template-store";
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

interface Actor { orgId: string; userId: string; email: string; tier: OrgTier; roles: ReadonlySet<QuoteRole> }

async function authorise(): Promise<Actor> {
  const { orgId } = await requireNewquipPocOrg();
  const access = await requireModuleAccess(QUOTES_MODULE.href);
  let tier: OrgTier = "member";
  try {
    await requireOrgAdmin("act as a NewQuip manager");
    tier = "admin";
  } catch {
    tier = "member"; // fail closed: anything that is not provably admin is a plain member
  }
  return { orgId, userId: access.userId, email: access.email ?? "unknown", tier, roles: rolesFor(tier) };
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
  const canViewCommercials = a.tier === "admin";
  return {
    quote: redactInternalFinancials(quote, canViewCommercials),
    evaluation: evaluateDraft(quote.draft, evaluationContext(!canViewCommercials)),
    viewer: { roles: [...a.roles], canViewCommercials },
  };
}

export async function getGrowerViewerAction(): Promise<GrowerActionResult<{ roles: QuoteRole[]; canViewCommercials: boolean }>> {
  try {
    const a = await authorise();
    return { ok: true, data: { roles: [...a.roles], canViewCommercials: a.tier === "admin" } };
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
    await logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.quote_created", summary: `Started NewQuip quote ${r.quoteRef} (local only; no Cin7 write)`, detail: { quoteId: r.id } });
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
    return { ok: true, data: evaluateDraft(draft, evaluationContext(a.tier !== "admin")) };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}

export async function saveGrowerDraftAction(quoteId: string, draft: QuoteDraft): Promise<GrowerActionResult<QuoteView>> {
  try {
    const a = await authorise();
    const db = createServiceRoleClient();
    const prior = await loadQuote(db, a.orgId, quoteId);
    await saveDraft(db, a.orgId, a.roles, quoteId, stampCostOverrides(draft, prior?.draft.estimator.costOverrides, a.tier === "admin", a.email, new Date().toISOString()));
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
    await logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action, summary: `${summary} (local only; no Cin7 write)`, detail: { quoteId } });
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
    sendToEstimator(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true), { confirmedAmountCents, confirmedBy }));
}

export async function returnGrowerQuoteToRepAction(quoteId: string, reason: string) {
  return step(quoteId, "Returned a NewQuip quote to the rep", "newquip.quote_returned_to_rep", async (a, db) => {
    if (await approvalsAvailable(db)) {
      // A manager returning a submitted quote is a recorded RETURN decision (reason required); an estimator pulling it back withdraws the submission.
      if (a.roles.has("manager")) { await decideDocument(db, legacyCtx(a.orgId, a.userId, a.email, true), "QUOTE", quoteId, "RETURN", { reason }); return; }
      await returnToRep(db, a.orgId, a.roles, quoteId, reason);
      await withdrawPendingFor(db, legacyCtx(a.orgId, a.userId, a.email, false), "QUOTE", quoteId, reason).catch(() => undefined);
      return;
    }
    await returnToRep(db, a.orgId, a.roles, quoteId, reason);
  });
}

export async function signOffGrowerQuoteAction(quoteId: string) {
  return step(quoteId, "Estimator signed off a NewQuip quote", "newquip.quote_estimator_signed_off", (a, db) =>
    estimatorSignOff(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true)).then(async () => {
      // The sign-off is the submission to the approving manager: record the exact revision + digest on the Approvals dashboard.
      if (await approvalsAvailable(db)) await submitForApproval(db, legacyCtx(a.orgId, a.userId, a.email, a.tier === "admin"), "QUOTE", quoteId).catch(() => undefined);
    }));
}

/** Manager final approval — freezes the accepted baseline. */
export async function approveGrowerQuoteAction(quoteId: string) {
  return step(quoteId, "Manager approved a NewQuip quote and froze the accepted baseline", "newquip.quote_manager_approved", async (a, db) => {
    // One approval path: when the Approvals framework is available the decision is recorded there (separation of duties, exact revision, history).
    if (await approvalsAvailable(db)) { await decideDocument(db, legacyCtx(a.orgId, a.userId, a.email, a.roles.has("manager")), "QUOTE", quoteId, "APPROVE"); return; }
    // Approval evaluates with cost withheld; the INTERNAL margin sheet is frozen from a second, cost-visible evaluation of the same draft.
    await managerApprove(db, a.orgId, a.roles, a.email, quoteId, evaluationContext(true), evaluationContext(false));
  });
}

/** What the project was actually created with (read back from the database, never echoed from the request). */
export interface CreatedProjectResult { projectId: string; created: boolean; billingSchedule: string | null; stages: Array<{ name: string; valueCents: number }> }

/**
 * The schedule a new project is created with. A TEMPLATE choice is re-read from the database (org-scoped, ACTIVE only) - the client's copy of the stages is
 * only honoured as a per-project customisation, which is re-validated to 100% - and the version used is recorded in the project's provenance.
 */
async function resolveProjectSchedule(db: ReturnType<typeof createServiceRoleClient>, orgId: string, choice?: ScheduleChoice): Promise<{ schedule: readonly ScheduleStageTemplate[]; label: string; source: ScheduleSource }> {
  if (choice?.preset === "TEMPLATE") {
    if (!choice.templateId) throw new Error("Choose a project template.");
    const t = await loadActiveTemplateVersion(db, orgId, choice.templateId);
    if (!t) throw new Error("Project template not found.");
    let schedule: readonly ScheduleStageTemplate[] = t.version.stages;
    if (choice.stages) {
      const custom = resolveScheduleChoice(choice);
      if (!custom.ok) throw new Error(`Billing schedule: ${custom.errors.join(" ")}`);
      const byName = new Map(t.version.stages.map((s) => [s.name.trim().toLowerCase(), s]));
      schedule = custom.schedule.map((s) => { const o = byName.get(s.name.trim().toLowerCase()); return o ? { ...s, description: o.description, trigger: o.trigger } : s; });
    }
    const customised = !sameSchedule(schedule, t.version.stages);
    return { schedule, label: `${t.template.name} v${t.version.version}${customised ? " (customised for this project)" : ""}`,
      source: { kind: "TEMPLATE", templateId: t.template.id, templateName: t.template.name, templateVersion: t.version.version, customised } };
  }
  const resolved = resolveScheduleChoice(choice);
  if (!resolved.ok) throw new Error(`Billing schedule: ${resolved.errors.join(" ")}`);
  return { schedule: resolved.schedule, label: resolved.label, source: { kind: !choice || choice.preset === "STANDARD" ? "STANDARD" : choice.preset === "SIX_STAGE" ? "SIX_STAGE" : "CUSTOM" } };
}

export async function createProjectFromGrowerQuoteAction(quoteId: string, scheduleChoice?: ScheduleChoice): Promise<GrowerActionResult<CreatedProjectResult>> {
  try {
    const a = await authorise();
    if (!a.roles.has("manager") && !a.roles.has("estimator")) throw new Error("You do not have permission to create a Project.");
    const db = createServiceRoleClient();
    const applied = await resolveProjectSchedule(db, a.orgId, scheduleChoice);
    const resolved = { schedule: applied.schedule, label: applied.label };
    const r = await createProjectFromAcceptedQuote(db, a.orgId, a.email, quoteId, resolved.schedule, applied.source);
    if (r.created) await logActivity(db, { orgId: a.orgId, actor: { userId: a.userId, email: a.email }, action: "newquip.project_created", summary: "Created a Project from an accepted NewQuip quote (local only; no Cin7 write)", detail: { quoteId, projectId: r.projectId, billingSchedule: resolved.label, stages: resolved.schedule.map((x) => `${x.name} ${(x.bps / 100).toFixed(2)}%`) } });
    const persisted = await db.from("project_stages").select("name, value_cents, sort_order").eq("org_id", a.orgId).eq("project_id", r.projectId).order("sort_order", { ascending: true });
    if (persisted.error) throw new Error(persisted.error.message);
    const stages = ((persisted.data ?? []) as Array<{ name: string; value_cents: number }>).map((x) => ({ name: x.name, valueCents: x.value_cents }));
    return { ok: true, data: { ...r, billingSchedule: r.created ? resolved.label : null, stages } };
  } catch (e) {
    return { ok: false, error: errMsg(e) };
  }
}
