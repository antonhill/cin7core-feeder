import "server-only";
// NewQuip commercial approvals: persistence + orchestration. ONE engine for quotations, progress claims and variations. The documents keep their
// own approve / return / cancel actions (reused here, never re-implemented); this module records the canonical approval state of each submission
// through the transactional database functions of migration 0110, and applies the matching document action. It never calls Cin7: approving a claim
// authorises the commercial claim only, and posting it to Cin7 stays the separate, existing action.
//
// Order of a decision: verify (permission, state, exact digest of the CURRENT document) -> apply the document's own action (compare-and-set, so only
// one of two concurrent managers wins) -> record the decision, event and notifications in one database transaction. If recording fails after the
// document changed, retrying the same decision reconciles (the document is already in the target state and the digest still matches).
import type { createServiceRoleClient } from "@/supabase/server";
import { sendEmail } from "@/lib/email/resend";
import { applyEmailPolicy, approvalBaseUrl, SUPPRESSED_MARK, type EmailEnv } from "./email-policy";
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { managerApprove, returnToRep, returnToEstimator, estimatorSignOff, loadQuote } from "@/lib/newquip-quotes/quote-store";
import { rolesFor } from "@/newquip/quote/roles";
import { approveClaim, cancelDraftClaim, returnClaimToDraft } from "@/lib/projects/project-store";
import { approveVariation, rejectVariation } from "@/lib/projects/variation-store";
import { listVariationStages } from "@/lib/projects/variation-billing-store";
import { authoriseDecision, authoriseStageDecision } from "./policy";
import { demoAuditDetail, type DemoInfo } from "@/lib/demo-mode/context";
import { logActivity } from "@/lib/activity-log";
import { canAdminister, stageOf, STAGE_LABEL, ROLE_LABEL, type ApprovalStage, type FunctionalRole } from "./roles";
import { emailsWithRole, loadPolicies, resolveRoles, rolesAvailable } from "./role-store";
import { APPROVALS_DISABLED } from "./kill-switch";
export { assertNotPendingApproval } from "./pending-guard";
import { claimDigest, quoteDigest, variationDigest } from "./digest";
import { buildNotification, type NotificationSpec } from "./messages";
import { addBusinessDays, isOverdue } from "./time";
import { DEFAULT_APPROVAL_SETTINGS, type ApprovalAction, type ApprovalDocType, type ApprovalEventRow, type ApprovalNotificationRow, type ApprovalRequestRow, type ApprovalSettings } from "./types";

type Db = ReturnType<typeof createServiceRoleClient>;
function fail(message: string): never { throw new Error(message); }
const missing = (m: string) => /does not exist|schema cache|relation|function .* does not exist|Could not find the function/i.test(m);
export const MAX_EMAIL_ATTEMPTS = 3;

export interface ApprovalCtx {
  orgId: string; userId: string; email: string; name: string; isManager: boolean; baseUrl?: string;
  /** Present only under the owner's Demo Mode: `email`/`userId` are the EFFECTIVE test user (every check evaluates them); `name` carries the DEMO marker. */
  demo?: DemoInfo;
}

/** False until migration 0110 is applied: every caller then keeps the documents' previous behaviour. Never reports an error as "no approvals". */
export async function approvalsAvailable(db: Db): Promise<boolean> {
  if (APPROVALS_DISABLED) return false; // operational kill switch (see kill-switch.ts)
  const r = await db.from("approval_requests").select("id").limit(1);
  if (!r.error) return true;
  if (missing(r.error.message)) return false;
  fail(`approvals: ${r.error.message}`);
}

export async function loadSettings(db: Db, orgId: string): Promise<ApprovalSettings> {
  const r = await db.from("approval_settings").select("*").eq("org_id", orgId).maybeSingle();
  if (r.error || !r.data) return DEFAULT_APPROVAL_SETTINGS;
  const s = r.data as { target_business_days: number; reminder_every_hours: number; max_reminders: number; escalation_email: string | null };
  return { targetBusinessDays: s.target_business_days, reminderEveryHours: s.reminder_every_hours, maxReminders: s.max_reminders, escalationEmail: s.escalation_email };
}

export async function managerEmails(db: Db, orgId: string): Promise<string[]> {
  const m = await db.from("org_members").select("user_id, role").eq("org_id", orgId).in("role", ["owner", "admin"]);
  if (m.error) fail(m.error.message);
  const out: string[] = [];
  for (const row of (m.data ?? []) as Array<{ user_id: string }>) {
    const u = await db.auth.admin.getUserById(row.user_id);
    if (u.data?.user?.email) out.push(u.data.user.email.toLowerCase());
  }
  return out;
}

// ── document snapshots ──────────────────────────────────────────────────────

export type DocState = "SUBMITTABLE" | "APPROVED" | "RETURNED" | "REJECTED" | "UNSIGNED" | "OTHER";
export interface DocSnapshot {
  docType: ApprovalDocType; docId: string; docRef: string; projectId: string | null; projectRef: string | null; customer: string | null; amountCents: number;
  preparedBy: string; /** The person who started the document (the salesperson for a quotation). */ originator?: string | null; digest: string; state: DocState; stateLabel: string;
  /** For a claim in a variation billing project: the customer-facing parent project and the variation reference. */
  scopeLabel: string | null;
}

async function projectInfo(db: Db, orgId: string, projectId: string): Promise<{ ref: string; customer: string | null; parentId: string | null; scope: string | null; variationCode: string | null }> {
  const p = await db.from("projects").select("id, project_reference, customer_name, parent_project_id, billing_scope, variation_id").eq("org_id", orgId).eq("id", projectId).maybeSingle();
  if (p.error) fail(p.error.message);
  if (!p.data) fail("Project not found.");
  const row = p.data as { project_reference: string; customer_name: string | null; parent_project_id: string | null; billing_scope: string | null; variation_id: string | null };
  if (row.parent_project_id) { // a variation billing project: the customer-facing project is the parent
    const par = await db.from("projects").select("project_reference, customer_name").eq("org_id", orgId).eq("id", row.parent_project_id).maybeSingle();
    const v = row.variation_id ? await db.from("project_variations").select("code").eq("org_id", orgId).eq("id", row.variation_id).maybeSingle() : null;
    const pr = par.data as { project_reference: string; customer_name: string | null } | null;
    return { ref: pr?.project_reference ?? row.project_reference, customer: pr?.customer_name ?? row.customer_name, parentId: row.parent_project_id, scope: "VARIATION", variationCode: (v?.data as { code: string } | null)?.code ?? null };
  }
  return { ref: row.project_reference, customer: row.customer_name, parentId: null, scope: row.billing_scope, variationCode: null };
}

export async function loadSnapshot(db: Db, orgId: string, docType: ApprovalDocType, docId: string, stage: ApprovalStage = "MANAGER"): Promise<DocSnapshot> {
  if (docType === "QUOTE") {
    const q = await loadQuote(db, orgId, docId);
    if (!q) fail("Quote not found.");
    const proj = q.project_id ? await projectInfo(db, orgId, q.project_id) : null;
    const signed = q.state === "ESTIMATOR_REVIEW" && !!q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash && q.customer_confirmed_cents != null;
    const confirmed = q.state === "ESTIMATOR_REVIEW" && q.customer_confirmed_cents != null;
    const rep = (q.handoff_by_email ?? q.created_by_email ?? "unknown").toLowerCase();
    // ESTIMATOR stage: the quote waits for the estimator's sign-off. MANAGER stage: it waits for the manager, and only after a sign-off of THIS content.
    const state: DocState = stage === "ESTIMATOR"
      ? (confirmed ? (signed ? "APPROVED" : "SUBMITTABLE") : q.state === "REP_DRAFT" ? "RETURNED" : "OTHER")
      : (signed ? "SUBMITTABLE" : q.state === "MANAGER_APPROVED_FINAL" ? "APPROVED" : q.state === "REP_DRAFT" ? "RETURNED" : q.state === "ESTIMATOR_REVIEW" ? "UNSIGNED" : "OTHER");
    return {
      docType, docId, docRef: q.quote_ref, projectId: q.project_id, projectRef: proj?.ref ?? null, customer: q.customer_name, amountCents: q.customer_confirmed_cents ?? q.contract_cents ?? 0,
      preparedBy: stage === "ESTIMATOR" ? rep : (q.estimator_signoff_by_email ?? q.handoff_by_email ?? q.created_by_email ?? "unknown").toLowerCase(), originator: rep,
      digest: quoteDigest({ quoteRef: q.quote_ref, revision: q.revision, draftHash: q.draft_hash, confirmedCents: q.customer_confirmed_cents ?? 0 }), state, stateLabel: q.state, scopeLabel: null,
    };
  }
  if (docType === "CLAIM") {
    const c = await db.from("project_claims").select("*").eq("org_id", orgId).eq("id", docId).maybeSingle();
    if (c.error) fail(c.error.message);
    if (!c.data) fail("Claim not found.");
    const claim = c.data as { project_id: string; claim_number: string; status: string; snapshot_hash: string; baseline_hash: string; subtotal_cents: number; tax_cents: number; author_email: string };
    const proj = await projectInfo(db, orgId, claim.project_id);
    const state: DocState = claim.status === "READY_FOR_APPROVAL" ? "SUBMITTABLE" : ["APPROVED", "CIN7_PENDING", "CIN7_CREATED", "RECONCILED", "FAILED_UNCERTAIN"].includes(claim.status) ? "APPROVED" : claim.status === "DRAFT" ? "RETURNED" : claim.status === "CANCELLED_BEFORE_WRITE" ? "REJECTED" : "OTHER";
    return {
      docType, docId, docRef: claim.claim_number, projectId: claim.project_id, projectRef: proj.ref, customer: proj.customer, amountCents: claim.subtotal_cents, preparedBy: claim.author_email.toLowerCase(),
      digest: claimDigest({ claimId: docId, claimNumber: claim.claim_number, snapshotHash: claim.snapshot_hash, baselineHash: claim.baseline_hash, subtotalCents: claim.subtotal_cents, taxCents: claim.tax_cents }),
      state, stateLabel: claim.status, scopeLabel: proj.scope === "VARIATION" ? `Variation ${proj.variationCode ?? ""}`.trim() : "Base contract",
    };
  }
  const v = await db.from("project_variations").select("*").eq("org_id", orgId).eq("id", docId).maybeSingle();
  if (v.error) fail(v.error.message);
  if (!v.data) fail("Variation not found.");
  const vr = v.data as { project_id: string; code: string; title: string; description: string | null; amount_cents: number; estimated_cost_cents?: number | null; status: string; raised_by_email: string };
  const proj = await projectInfo(db, orgId, vr.project_id);
  const stages = await listVariationStages(db, orgId, docId);
  const state: DocState = vr.status === "DRAFT" ? "SUBMITTABLE" : vr.status === "APPROVED" ? "APPROVED" : vr.status === "REJECTED" ? "REJECTED" : "OTHER";
  return {
    docType, docId, docRef: `${proj.ref} ${vr.code}`, projectId: vr.project_id, projectRef: proj.ref, customer: proj.customer, amountCents: vr.amount_cents, preparedBy: vr.raised_by_email.toLowerCase(),
    digest: variationDigest({ variationId: docId, code: vr.code, title: vr.title, description: vr.description, amountCents: vr.amount_cents, estimatedCostCents: vr.estimated_cost_cents ?? null, stages: stages.map((s) => ({ name: s.name, bps: s.bps })) }),
    state, stateLabel: vr.status, scopeLabel: `Variation ${vr.code}`,
  };
}

// ── requests ────────────────────────────────────────────────────────────────

export async function loadRequest(db: Db, orgId: string, requestId: string): Promise<ApprovalRequestRow | null> {
  const r = await db.from("approval_requests").select("*").eq("org_id", orgId).eq("id", requestId).maybeSingle();
  if (r.error) fail(r.error.message);
  return (r.data as ApprovalRequestRow | null) ?? null;
}
export async function listRequests(db: Db, orgId: string): Promise<ApprovalRequestRow[]> {
  const r = await db.from("approval_requests").select("*").eq("org_id", orgId);
  if (r.error) { if (missing(r.error.message)) return []; fail(r.error.message); }
  return (r.data ?? []) as ApprovalRequestRow[];
}
export async function latestRequestFor(db: Db, orgId: string, docType: ApprovalDocType, docId: string): Promise<ApprovalRequestRow | null> {
  const r = await db.from("approval_requests").select("*").eq("org_id", orgId).eq("doc_type", docType).eq("doc_id", docId);
  if (r.error) { if (missing(r.error.message)) return null; fail(r.error.message); }
  return ((r.data ?? []) as ApprovalRequestRow[]).sort((a, b) => b.revision - a.revision)[0] ?? null;
}
export async function pendingRequestFor(db: Db, orgId: string, docType: ApprovalDocType, docId: string): Promise<ApprovalRequestRow | null> {
  const l = await latestRequestFor(db, orgId, docType, docId);
  return l && l.status === "PENDING" ? l : null;
}
export async function docHistory(db: Db, orgId: string, docType: ApprovalDocType, docId: string): Promise<ApprovalEventRow[]> {
  const r = await db.from("approval_events").select("*").eq("org_id", orgId).eq("doc_type", docType).eq("doc_id", docId);
  if (r.error) { if (missing(r.error.message)) return []; fail(r.error.message); }
  return ((r.data ?? []) as ApprovalEventRow[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
}
export async function requestHistory(db: Db, orgId: string, requestId: string): Promise<ApprovalEventRow[]> {
  const r = await db.from("approval_events").select("*").eq("org_id", orgId).eq("request_id", requestId);
  if (r.error) { if (missing(r.error.message)) return []; fail(r.error.message); }
  return ((r.data ?? []) as ApprovalEventRow[]).sort((a, b) => a.created_at.localeCompare(b.created_at));
}

const asRequest = (r: unknown): ApprovalRequestRow => r as ApprovalRequestRow;

/**
 * Under the owner's Demo Mode every approval step also leaves a structured audit record: the REAL owner as the actor, with the effective test user, the role
 * they were demonstrating, the document revision, the action, the reason and the exact UTC time. (The immutable approval history itself already carries the
 * effective user as the actor and the DEMO marker in the actor name.) Never throws: a decision does not depend on this record.
 */
async function auditDemo(db: Db, ctx: ApprovalCtx, action: string, summary: string, req: ApprovalRequestRow, extra: Record<string, unknown> = {}): Promise<void> {
  if (!ctx.demo) return;
  await logActivity(db, {
    orgId: ctx.orgId, actor: { userId: ctx.demo.ownerUserId, email: ctx.demo.ownerEmail }, action, summary: `[DEMO] ${summary}`,
    detail: demoAuditDetail(ctx.demo, { requestId: req.id, docType: req.doc_type, docId: req.doc_id, docRef: req.doc_ref, documentRevision: req.revision, stage: req.stage ?? "MANAGER", decisionAction: extra.decisionAction ?? null, atUtc: new Date().toISOString(), ...extra }),
  }).catch(() => undefined);
}

const newId = () => crypto.randomUUID();

/** Submits the CURRENT revision of a document. Records the exact digest and amount; identical content already pending is a no-op; changed content supersedes the pending submission. */
export async function submitForApproval(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string, opts: { assignTo?: string | null; now?: Date; actor?: { email: string; name: string }; stage?: ApprovalStage; quiet?: boolean } = {}): Promise<ApprovalRequestRow> {
  if (await stagedAvailable(db)) return submitStaged(db, ctx, docType, docId, opts);
  const now = opts.now ?? new Date();
  const snap = await loadSnapshot(db, ctx.orgId, docType, docId);
  if (snap.state !== "SUBMITTABLE") fail(`This ${docType.toLowerCase()} is not in a state that can be submitted for approval (${snap.stateLabel}).`);
  const settings = await loadSettings(db, ctx.orgId);
  const managers = await managerEmails(db, ctx.orgId);
  const assignee = (opts.assignTo ?? "").trim().toLowerCase() || null;
  if (assignee && !managers.includes(assignee)) fail("The assigned approver must be a manager (organisation owner or admin).");
  const id = newId();
  const dueAt = addBusinessDays(now.toISOString(), settings.targetBusinessDays);
  const draftReq = { id, org_id: ctx.orgId, doc_type: docType, doc_id: docId, doc_ref: snap.docRef, project_id: snap.projectId, project_ref: snap.projectRef, customer_name: snap.customer, revision: 1, digest: snap.digest, amount_cents: snap.amountCents, status: "PENDING", prepared_by_email: snap.preparedBy, submitted_at: now.toISOString(), assigned_to_email: assignee, assigned_at: null, due_at: dueAt, first_viewed_at: null, decided_by_email: null, decided_by_name: null, decided_at: null, decision_reason: null, admin_override: false, closed_at: null, version: 1, reminders_sent: 0, last_reminder_at: null, created_at: now.toISOString() } as ApprovalRequestRow;
  const recipients = assignee ? [assignee] : managers.filter((m) => m !== snap.preparedBy).length ? managers.filter((m) => m !== snap.preparedBy) : managers;
  const prior = await latestRequestFor(db, ctx.orgId, docType, docId);
  const specs = recipients.map((to) => buildNotification(prior ? "RESUBMITTED" : "SUBMITTED", draftReq, to, { baseUrl: ctx.baseUrl, by: ctx.name }));
  const r = await db.rpc("approval_submit", {
    p_org: ctx.orgId, p_id: id, p_doc_type: docType, p_doc_id: docId, p_doc_ref: snap.docRef, p_project_id: snap.projectId, p_project_ref: snap.projectRef, p_customer: snap.customer,
    p_digest: snap.digest, p_amount: snap.amountCents, p_prepared_by: snap.preparedBy, p_assigned_to: assignee, p_due_at: dueAt, p_actor: opts.actor?.email ?? ctx.email, p_actor_name: opts.actor?.name ?? ctx.name, p_notifications: specs,
  });
  if (r.error) fail(`submit for approval: ${r.error.message}`);
  const row = asRequest(r.data);
  await auditDemo(db, ctx, "approvals.submitted", `Submitted ${docType.toLowerCase()} ${row.doc_ref} for approval`, row, { decisionAction: "SUBMIT" });
  await deliverForRequest(db, row.id).catch(() => undefined); // best effort: a decision never depends on delivery
  return row;
}

function decisionNotifications(action: ApprovalAction, req: ApprovalRequestRow, ctx: ApprovalCtx, reason: string): NotificationSpec[] {
  if (action === "WITHDRAW") return [];
  const kind = action === "APPROVE" ? "APPROVED" : action === "RETURN" ? "RETURNED" : "REJECTED";
  return [buildNotification(kind, req, req.prepared_by_email, { baseUrl: ctx.baseUrl, reason: reason || null, by: ctx.name })];
}

/** The target state of a document after a decision, for reconciliation after a partial failure. */
function matchesTarget(action: ApprovalAction, snap: DocSnapshot): boolean {
  if (action === "APPROVE") return snap.state === "APPROVED";
  if (action === "RETURN") return snap.state === "RETURNED";
  if (action === "REJECT") return snap.docType === "VARIATION" ? snap.state === "REJECTED" : snap.docType === "CLAIM" ? snap.state === "REJECTED" : snap.state === "RETURNED";
  return true;
}

export async function decide(db: Db, ctx: ApprovalCtx, requestId: string, action: ApprovalAction, input: { reason?: string; override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null; expectedVersion: number; expectedDigest: string }): Promise<ApprovalRequestRow> {
  const req = await loadRequest(db, ctx.orgId, requestId);
  if (!req) fail("Approval request not found.");
  if (req.stage !== undefined) return decideStaged(db, ctx, req, action, input); // a database with migration 0112 returns the stage on every request
  const verdict = authoriseDecision({ email: ctx.email, isManager: ctx.isManager }, action, req, input);
  if (!verdict.ok) fail(verdict.error);
  if (req.version !== input.expectedVersion || req.digest !== input.expectedDigest) fail("This submission changed while you were reviewing it. Reload and review the current revision before deciding.");
  const reason = (input.reason ?? "").trim();
  if (action !== "WITHDRAW") {
    const snap = await loadSnapshot(db, ctx.orgId, req.doc_type, req.doc_id);
    if (snap.digest !== req.digest) fail("The document has changed since it was submitted, so this submission can no longer be decided. Ask the preparer to resubmit the current revision.");
    if (snap.state === "SUBMITTABLE") {
      await applyDocumentAction(db, ctx, req, action, reason);
    } else if (!matchesTarget(action, snap)) {
      fail(`The ${req.doc_type.toLowerCase()} is no longer waiting for approval (${snap.stateLabel}).`);
    } // else: already in the target state (a previous attempt changed it but could not record the decision): reconcile below
  }
  const r = await db.rpc("approval_decide", {
    p_org: ctx.orgId, p_request: requestId, p_action: action, p_actor: ctx.email, p_actor_name: ctx.name, p_reason: reason || null, p_expected_version: input.expectedVersion,
    p_expected_digest: input.expectedDigest, p_override: verdict.override, p_notifications: decisionNotifications(action, req, ctx, reason),
  });
  if (r.error) fail(r.error.message.replace(/^.*?(approval_[a-z_]+: )/, "").replace(/^approval: /, ""));
  const row = asRequest(r.data);
  await auditDemo(db, ctx, `approvals.${action.toLowerCase()}`, `${action} ${row.doc_type.toLowerCase()} ${row.doc_ref}`, row, { decisionAction: action, reason: reason || null, override: verdict.override, decidedAtUtc: row.decided_at });
  await deliverForRequest(db, row.id).catch(() => undefined);
  return row;
}

/** The document's own existing action. Compare-and-set inside each, so a concurrent second manager fails here. */
async function applyDocumentAction(db: Db, ctx: ApprovalCtx, req: ApprovalRequestRow, action: ApprovalAction, reason: string): Promise<void> {
  const mgrRoles = rolesFor("admin");
  if (req.doc_type === "QUOTE") {
    if (action === "APPROVE") await managerApprove(db, ctx.orgId, mgrRoles, ctx.email, req.doc_id, evaluationContext(true), evaluationContext(false));
    else if (action === "RETURN") await returnToRep(db, ctx.orgId, mgrRoles, req.doc_id, reason);
    else if (action === "REJECT") await returnToRep(db, ctx.orgId, mgrRoles, req.doc_id, `Rejected: ${reason}`); // a quote has no cancelled state: it goes back to the rep, the rejection is recorded
    return;
  }
  const projectId = req.project_id ?? fail("The submission has no project.");
  if (req.doc_type === "CLAIM") {
    if (action === "APPROVE") await approveClaim(db, ctx.orgId, ctx.email, projectId, req.doc_id);
    else if (action === "RETURN") await returnClaimToDraft(db, ctx.orgId, projectId, req.doc_id);
    else if (action === "REJECT") await cancelDraftClaim(db, ctx.orgId, projectId, req.doc_id);
    return;
  }
  if (action === "APPROVE") await approveVariation(db, ctx.orgId, ctx.email, projectId, req.doc_id, reason);
  else if (action === "REJECT") await rejectVariation(db, ctx.orgId, ctx.email, projectId, req.doc_id, reason);
  // RETURN: a variation stays a DRAFT, editable by the preparer; only the request changes.
}

export async function reassign(db: Db, ctx: ApprovalCtx, requestId: string, newApprover: string, expectedVersion: number): Promise<ApprovalRequestRow> {
  const req = await loadRequest(db, ctx.orgId, requestId);
  if (!req) fail("Approval request not found.");
  if (req.status !== "PENDING") fail(`This submission is already ${req.status.toLowerCase()}.`);
  const to = newApprover.trim().toLowerCase();
  if (req.stage !== undefined) {
    // Staged: an administrator, a manager, or the current assignee may hand the stage to someone who holds that stage's role.
    const roles = await resolveRoles(db, ctx.orgId, ctx.userId, ctx.isManager);
    if (!(canAdminister(roles, ctx.isManager) || roles.has("MANAGER") || (req.assigned_to_email ?? "") === ctx.email)) fail("Only an administrator, a manager or the current approver can reassign an approval.");
    const need = (req.stage_role as FunctionalRole | null) ?? "MANAGER";
    if (!(await emailsWithRole(db, ctx.orgId, need)).includes(to)) fail(`The new approver must hold the ${ROLE_LABEL[need]} role.`);
  } else {
    if (!ctx.isManager) fail("Only a manager can reassign an approval.");
    if (!(await managerEmails(db, ctx.orgId)).includes(to)) fail("The new approver must be a manager (organisation owner or admin).");
  }
  const specs: NotificationSpec[] = [buildNotification("REASSIGNED", req, to, { baseUrl: ctx.baseUrl, by: ctx.name, newApprover: to })];
  if (req.assigned_to_email && req.assigned_to_email !== to) specs.push(buildNotification("REASSIGNED_AWAY", req, req.assigned_to_email, { baseUrl: ctx.baseUrl, by: ctx.name, newApprover: to }));
  const r = await db.rpc("approval_reassign", { p_org: ctx.orgId, p_request: requestId, p_new: to, p_actor: ctx.email, p_actor_name: ctx.name, p_expected_version: expectedVersion, p_notifications: specs });
  if (r.error) fail(r.error.message);
  await auditDemo(db, ctx, "approvals.reassigned", `Reassigned ${req.doc_type.toLowerCase()} ${req.doc_ref} to ${to}`, asRequest(r.data), { decisionAction: "REASSIGN", newApprover: to });
  await deliverForRequest(db, requestId).catch(() => undefined);
  return asRequest(r.data);
}

export async function markViewed(db: Db, ctx: ApprovalCtx, requestId: string): Promise<void> {
  if (!ctx.isManager) return;
  await db.rpc("approval_mark_viewed", { p_org: ctx.orgId, p_request: requestId, p_actor: ctx.email, p_actor_name: ctx.name });
}

// ── notifications ───────────────────────────────────────────────────────────

export async function myNotifications(db: Db, orgId: string, email: string, limit = 50): Promise<ApprovalNotificationRow[]> {
  const r = await db.from("approval_notifications").select("*").eq("org_id", orgId).eq("recipient_email", email.toLowerCase()).eq("channel", "IN_APP");
  if (r.error) { if (missing(r.error.message)) return []; fail(r.error.message); }
  return ((r.data ?? []) as ApprovalNotificationRow[]).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}
export async function markNotificationsRead(db: Db, orgId: string, email: string, ids: string[] | "ALL"): Promise<void> {
  let q = db.from("approval_notifications").update({ read_at: new Date().toISOString() }).eq("org_id", orgId).eq("recipient_email", email.toLowerCase()).eq("channel", "IN_APP").is("read_at", null);
  if (ids !== "ALL") q = q.in("id", ids);
  const r = await q;
  if (r.error) fail(r.error.message);
}

/**
 * Email outbox. EVERY approval email passes through `deliverRows`, the single place that applies the outbound policy (Preview allowlist, [PREVIEW] marking) and
 * the attempt cap. Statuses: SENT = the provider API accepted it (not proof of inbox delivery), FAILED / ABANDONED = the provider refused it, SUPPRESSED = the
 * policy withheld it (never counted as a failure, never redirected, never consumes an attempt).
 */
export type EmailPolicyEnv = EmailEnv;
type DeliverStatuses = ReadonlyArray<"PENDING" | "FAILED">;
const QUEUE_ONLY: DeliverStatuses = ["PENDING"];           // inline sends and "Send pending now": never touches a FAILED row
const QUEUE_AND_RETRY: DeliverStatuses = ["PENDING", "FAILED"]; // the scheduled worker (Production only), which retries within the attempt cap
export interface DeliverResult { sent: number; failed: number; suppressed: number }

async function markSuppressed(db: Db, id: string, reason: string, statuses: DeliverStatuses): Promise<boolean> {
  // Prefer the dedicated status (migration 0114); until the database accepts it, record ABANDONED with an unmistakable marker so it is still distinct from FAILED.
  const first = await db.from("approval_notifications").update({ status: "SUPPRESSED", last_error: reason }).eq("id", id).in("status", [...statuses]).select("id");
  if (!first.error) return !!first.data?.length;
  const fallback = await db.from("approval_notifications").update({ status: "ABANDONED", last_error: `${SUPPRESSED_MARK} ${reason}`.slice(0, 500) }).eq("id", id).in("status", [...statuses]).select("id");
  return !fallback.error && !!fallback.data?.length;
}

async function deliverRows(db: Db, rows: ApprovalNotificationRow[], send: typeof sendEmail, env: EmailPolicyEnv, statuses: DeliverStatuses): Promise<DeliverResult> {
  let sent = 0; let failed = 0; let suppressed = 0;
  for (const row of rows) {
    const n = { ...row }; // work on a copy: the attempt counter we compare-and-set against must not move under us
    if (n.attempts >= MAX_EMAIL_ATTEMPTS) continue;
    // the outbound policy is decided BEFORE an attempt is claimed: a suppressed email costs no attempt and reaches no provider
    const decision = applyEmailPolicy(env, { to: n.recipient_email, subject: n.subject, text: n.body });
    if (decision.action === "SUPPRESS") { if (await markSuppressed(db, n.id, decision.reason, statuses)) suppressed += 1; continue; }
    // claim the attempt (compare-and-set on the attempt counter): two workers never send the same notification twice
    const claim = await db.from("approval_notifications").update({ attempts: n.attempts + 1 }).eq("id", n.id).eq("attempts", n.attempts).in("status", [...statuses]).select("id");
    if (claim.error || !claim.data?.length) continue;
    const res = await send({ to: [n.recipient_email], subject: decision.subject, text: decision.text });
    if (res.ok) {
      await db.from("approval_notifications").update({ status: "SENT", sent_at: new Date().toISOString(), provider_message_id: res.messageId ?? null, last_error: null }).eq("id", n.id);
      sent += 1;
    } else {
      const exhausted = n.attempts + 1 >= MAX_EMAIL_ATTEMPTS;
      await db.from("approval_notifications").update({ status: exhausted ? "ABANDONED" : "FAILED", last_error: (res.error ?? "unknown error").slice(0, 500) }).eq("id", n.id);
      failed += 1;
    }
  }
  return { sent, failed, suppressed };
}

/** Best-effort inline send right after a decision: only the request's QUEUED rows (a FAILED row is never retried implicitly). */
export async function deliverForRequest(db: Db, requestId: string, send: typeof sendEmail = sendEmail, env: EmailPolicyEnv = process.env): Promise<DeliverResult> {
  const r = await db.from("approval_notifications").select("*").eq("request_id", requestId).eq("channel", "EMAIL").eq("status", "PENDING");
  if (r.error) return { sent: 0, failed: 0, suppressed: 0 };
  return deliverRows(db, (r.data ?? []) as ApprovalNotificationRow[], send, env, QUEUE_ONLY);
}

/**
 * Drains the outbox, oldest first. The scheduled worker (Production only) retries FAILED rows within the attempt cap; a manager's "Send pending now" passes
 * { orgId, retryFailed: false } so it sends QUEUED rows of their own organisation only.
 */
export async function deliverPendingEmails(db: Db, send: typeof sendEmail = sendEmail, limit = 50, opts: { env?: EmailPolicyEnv; orgId?: string; retryFailed?: boolean } = {}): Promise<DeliverResult> {
  const statuses = opts.retryFailed === false ? QUEUE_ONLY : QUEUE_AND_RETRY;
  let q = db.from("approval_notifications").select("*").eq("channel", "EMAIL").in("status", [...statuses]);
  if (opts.orgId) q = q.eq("org_id", opts.orgId);
  const r = await q;
  if (r.error) return { sent: 0, failed: 0, suppressed: 0 };
  return deliverRows(db, ((r.data ?? []) as ApprovalNotificationRow[]).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit), send, opts.env ?? process.env, statuses);
}

/**
 * Manager only. Re-queues ONE failed / abandoned / suppressed email and dispatches exactly that row, through the same policy, attempt claim and audit as every
 * other send. The re-queue is a compare-and-set on the current status, so a double click or two managers cannot send it twice.
 */
export async function retryAndDispatchEmail(db: Db, ctx: ApprovalCtx, notificationId: string, send: typeof sendEmail = sendEmail, env: EmailPolicyEnv = process.env): Promise<DeliverResult> {
  if (!ctx.isManager) fail("Only a manager can retry a notification.");
  const r = await db.from("approval_notifications").update({ status: "PENDING", attempts: 0, last_error: null }).eq("org_id", ctx.orgId).eq("id", notificationId).eq("channel", "EMAIL").in("status", ["FAILED", "ABANDONED", "SUPPRESSED"]).select("*");
  if (r.error) fail(r.error.message);
  if (!r.data?.length) fail("That notification is not a failed email.");
  const result = await deliverRows(db, r.data as ApprovalNotificationRow[], send, env, QUEUE_ONLY);
  await logActivity(db, { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: "approvals.email_retry", summary: `Retried one approval email (${result.sent ? "accepted by the provider" : result.suppressed ? "suppressed by the Preview policy" : "not accepted"})`, detail: { notificationId, ...result } }).catch(() => undefined);
  return result;
}

/** Manager only: sends the organisation's QUEUED emails now (never a FAILED row; those need an explicit Retry). */
export async function sendPendingNow(db: Db, ctx: ApprovalCtx, send: typeof sendEmail = sendEmail, env: EmailPolicyEnv = process.env): Promise<DeliverResult> {
  if (!ctx.isManager) fail("Only a manager can send pending emails.");
  const result = await deliverPendingEmails(db, send, 50, { env, orgId: ctx.orgId, retryFailed: false });
  await logActivity(db, { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: "approvals.email_dispatch", summary: `Sent pending approval emails now (${result.sent} accepted, ${result.failed} failed, ${result.suppressed} suppressed)`, detail: { ...result } }).catch(() => undefined);
  return result;
}

/** The organisation's recent email outbox, newest first, in every status (so accepted, failed, suppressed and abandoned are all visible). */
export async function recentEmails(db: Db, orgId: string, limit = 50): Promise<ApprovalNotificationRow[]> {
  const r = await db.from("approval_notifications").select("*").eq("org_id", orgId).eq("channel", "EMAIL");
  if (r.error) { if (missing(r.error.message)) return []; fail(r.error.message); }
  return ((r.data ?? []) as ApprovalNotificationRow[]).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}
/** Emails needing an administrator's attention (failed, abandoned or suppressed). */
export async function failedEmails(db: Db, orgId: string): Promise<ApprovalNotificationRow[]> {
  const r = await db.from("approval_notifications").select("*").eq("org_id", orgId).eq("channel", "EMAIL").in("status", ["FAILED", "ABANDONED", "SUPPRESSED"]);
  if (r.error) { if (missing(r.error.message)) return []; fail(r.error.message); }
  return (r.data ?? []) as ApprovalNotificationRow[];
}

// ── reminders ───────────────────────────────────────────────────────────────

/** Overdue PENDING submissions get bounded reminders (one per cadence, never beyond the maximum). Nothing is ever approved or rejected by lateness. */
export async function sendOverdueReminders(db: Db, nowIso: string, baseUrl?: string): Promise<{ reminded: number }> {
  const r = await db.from("approval_requests").select("*").eq("status", "PENDING");
  if (r.error) { if (missing(r.error.message)) return { reminded: 0 }; fail(r.error.message); }
  let reminded = 0;
  const settingsCache = new Map<string, ApprovalSettings>();
  const managersCache = new Map<string, string[]>();
  for (const req of (r.data ?? []) as ApprovalRequestRow[]) {
    if (!isOverdue(req.due_at, nowIso)) continue;
    const s = settingsCache.get(req.org_id) ?? (await loadSettings(db, req.org_id)); settingsCache.set(req.org_id, s);
    if (req.reminders_sent >= s.maxReminders) continue;
    if (req.last_reminder_at && new Date(nowIso).getTime() - new Date(req.last_reminder_at).getTime() < s.reminderEveryHours * 3_600_000) continue;
    // Who is reminded: the named approver, else the holders of THIS stage's role (an estimator-stage request reminds estimators, not managers).
    const cacheKey = `${req.org_id}:${req.stage_role ?? "MANAGER"}`;
    const mgrs = managersCache.get(cacheKey) ?? (req.stage_role ? await emailsWithRole(db, req.org_id, req.stage_role as FunctionalRole) : await managerEmails(db, req.org_id)); managersCache.set(cacheKey, mgrs);
    const to = req.assigned_to_email ? [req.assigned_to_email] : mgrs;
    const n = req.reminders_sent + 1;
    const specs = to.map((t) => buildNotification("OVERDUE", req, t, { baseUrl, kindKey: `OVERDUE-${n}` }));
    if (n === 1 && s.escalationEmail) specs.push(buildNotification("ESCALATED", req, s.escalationEmail, { baseUrl, kindKey: `ESCALATED-${n}` }));
    const ok = await db.rpc("approval_record_reminder", { p_org: req.org_id, p_request: req.id, p_expected_reminders: req.reminders_sent, p_notifications: specs });
    if (!ok.error && ok.data === true) reminded += 1;
  }
  return { reminded };
}

// ── the existing approve / return / reject / cancel entry points route through here, so there is ONE approval path ──

export function legacyCtx(orgId: string, userId: string, email: string | null, isManager: boolean, opts: { name?: string; demo?: DemoInfo } = {}): ApprovalCtx {
  const base = approvalBaseUrl(process.env);
  return { orgId, userId, email: (email ?? "unknown").toLowerCase(), name: opts.name ?? email ?? "unknown", isManager, baseUrl: base, ...(opts.demo ? { demo: opts.demo } : {}) };
}

/**
 * A decision made from a document's own screen. The current revision is submitted first when nobody submitted it (recorded as submitted by its
 * preparer), then decided through the same checks as the Approvals dashboard: separation of duties, exact digest, history, notifications.
 */
export async function decideDocument(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string, action: Exclude<ApprovalAction, "WITHDRAW">, input: { reason?: string; override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null; stage?: ApprovalStage } = {}): Promise<ApprovalRequestRow> {
  let req = await pendingRequestFor(db, ctx.orgId, docType, docId);
  const staged = await stagedAvailable(db);
  if (!req) {
    if (staged && docType === "QUOTE") req = await resyncQuoteApprovals(db, ctx, docId, { quiet: true, actor: undefined });
    else {
      const snap = await loadSnapshot(db, ctx.orgId, docType, docId);
      req = await submitForApproval(db, ctx, docType, docId, { actor: { email: snap.preparedBy, name: snap.preparedBy } });
    }
    if (!req) fail(`This ${docType.toLowerCase()} is not waiting for a decision.`);
  }
  if (staged && input.stage && (req.stage ?? "MANAGER") !== input.stage) fail(`This quotation is waiting for ${STAGE_LABEL[req.stage ?? "MANAGER"].toLowerCase()}, not ${STAGE_LABEL[input.stage].toLowerCase()}.`);
  if (staged && req.stage === "ESTIMATOR") {
    // The estimator signs off the content they are looking at: if it changed since the request was opened, the request is re-opened on the current content first.
    const cur = await loadSnapshot(db, ctx.orgId, docType, docId, "ESTIMATOR");
    if (cur.state === "SUBMITTABLE" && cur.digest !== req.digest) req = await submitStaged(db, ctx, docType, docId, { stage: "ESTIMATOR", quiet: true, assignTo: req.assigned_to_email });
  }
  const { stage: _stage, ...rest } = input; void _stage;
  return decide(db, ctx, req.id, action, { ...rest, expectedVersion: req.version, expectedDigest: req.digest });
}

/** The preparer (or a manager) takes a document out of review by editing/cancelling it elsewhere: the pending submission is withdrawn, never left dangling. */
export async function withdrawPendingFor(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string, reason: string): Promise<void> {
  const req = await pendingRequestFor(db, ctx.orgId, docType, docId).catch(() => null);
  if (!req) return;
  const r = await db.rpc("approval_decide", { p_org: ctx.orgId, p_request: req.id, p_action: "WITHDRAW", p_actor: ctx.email, p_actor_name: ctx.name, p_reason: reason, p_expected_version: req.version, p_expected_digest: req.digest, p_override: false, p_notifications: [] });
  if (r.error) fail(r.error.message);
}

// ── staged approvals (migration 0112): quote = ESTIMATOR stage then MANAGER stage; claim and variation = MANAGER stage ──────────────────────────────────

/** True once migration 0112 is applied. Until then every function above behaves exactly as in Phase H. */
export async function stagedAvailable(db: Db): Promise<boolean> {
  if (APPROVALS_DISABLED) return false;
  return rolesAvailable(db);
}

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x).map((x) => x.toLowerCase()))];

/**
 * Submits one STAGE of the current revision. The assignee is the named approver of the stage's policy (or the one passed in), and must hold the stage's role;
 * with nobody named, every holder of the role is notified. Changed content supersedes a pending submission; identical content at the same stage is a no-op.
 */
async function submitStaged(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string, opts: { assignTo?: string | null; now?: Date; actor?: { email: string; name: string }; stage?: ApprovalStage; quiet?: boolean }): Promise<ApprovalRequestRow> {
  const now = opts.now ?? new Date();
  const stage = opts.stage ?? "MANAGER";
  if (stage === "ESTIMATOR" && docType !== "QUOTE") fail("Only a quotation has an estimator stage.");
  const snap = await loadSnapshot(db, ctx.orgId, docType, docId, stage);
  if (snap.state !== "SUBMITTABLE") fail(`This ${docType.toLowerCase()} is not in a state that can be submitted for ${stage === "ESTIMATOR" ? "estimator review" : "approval"} (${snap.stateLabel}).`);
  const settings = await loadSettings(db, ctx.orgId);
  const sp = stageOf(await loadPolicies(db, ctx.orgId), docType, stage);
  const holders = await emailsWithRole(db, ctx.orgId, sp.role);
  const assignee = (opts.assignTo ?? sp.approverEmail ?? "").trim().toLowerCase() || null;
  if (assignee && !holders.includes(assignee)) fail(`The assigned approver must hold the ${ROLE_LABEL[sp.role]} role.`);
  const id = newId();
  const dueAt = addBusinessDays(now.toISOString(), settings.targetBusinessDays);
  const prior = await latestRequestFor(db, ctx.orgId, docType, docId);
  const draftReq = { id, org_id: ctx.orgId, doc_type: docType, doc_id: docId, doc_ref: snap.docRef, project_id: snap.projectId, project_ref: snap.projectRef, customer_name: snap.customer, revision: (prior?.revision ?? 0) + 1, digest: snap.digest, amount_cents: snap.amountCents, status: "PENDING", prepared_by_email: snap.preparedBy, submitted_at: now.toISOString(), assigned_to_email: assignee, assigned_at: null, due_at: dueAt, first_viewed_at: null, decided_by_email: null, decided_by_name: null, decided_at: null, decision_reason: null, admin_override: false, closed_at: null, version: 1, reminders_sent: 0, last_reminder_at: null, created_at: now.toISOString(), stage, stage_role: sp.role, originator_email: snap.originator ?? null, return_destination: null } as ApprovalRequestRow;
  const others = holders.filter((h) => h !== snap.preparedBy && h !== (snap.originator ?? ""));
  const recipients = assignee ? [assignee] : others.length ? others : holders;
  const kind = stage === "ESTIMATOR" ? "ESTIMATOR_ASSIGNED" : docType === "QUOTE" ? "MANAGER_SUBMITTED" : prior ? "RESUBMITTED" : "SUBMITTED";
  const specs = opts.quiet ? [] : recipients.map((to) => buildNotification(kind, draftReq, to, { baseUrl: ctx.baseUrl, by: ctx.name, anyOf: `any ${ROLE_LABEL[sp.role]}` }));
  const r = await db.rpc("approval_submit_staged", {
    p_org: ctx.orgId, p_id: id, p_doc_type: docType, p_doc_id: docId, p_doc_ref: snap.docRef, p_project_id: snap.projectId, p_project_ref: snap.projectRef, p_customer: snap.customer,
    p_digest: snap.digest, p_amount: snap.amountCents, p_prepared_by: snap.preparedBy, p_originator: snap.originator ?? snap.preparedBy, p_stage: stage, p_stage_role: sp.role, p_assigned_to: assignee,
    p_due_at: dueAt, p_actor: opts.actor?.email ?? ctx.email, p_actor_name: opts.actor?.name ?? ctx.name, p_notifications: specs,
  });
  if (r.error) fail(`submit for ${STAGE_LABEL[stage].toLowerCase()}: ${r.error.message}`);
  const row = asRequest(r.data);
  await auditDemo(db, ctx, "approvals.submitted", `Submitted ${docType.toLowerCase()} ${row.doc_ref} for ${STAGE_LABEL[stage].toLowerCase()}`, row, { decisionAction: "SUBMIT", assignedTo: row.assigned_to_email });
  await deliverForRequest(db, row.id).catch(() => undefined); // best effort: a decision never depends on delivery
  return row;
}

function stagedDecisionNotifications(action: ApprovalAction, req: ApprovalRequestRow, ctx: ApprovalCtx, reason: string, destination: "ESTIMATOR" | "PREPARER" | null): NotificationSpec[] {
  if (action === "WITHDRAW") return [];
  const stage = req.stage ?? "MANAGER";
  const b = { baseUrl: ctx.baseUrl, reason: reason || null, by: ctx.name, at: new Date().toISOString() };
  const rep = req.originator_email ?? null;
  if (stage === "ESTIMATOR") {
    // Estimator signs off: the Manager is told by the manager-stage submission that follows; the Rep is told here (they are waiting on the outcome).
    if (action === "APPROVE") return uniq([rep ?? req.prepared_by_email]).map((to) => buildNotification("SIGNED_OFF_FOR_REP", req, to, b));
    return uniq([req.prepared_by_email, rep]).map((to) => buildNotification("RETURNED_TO_REP", req, to, b));
  }
  if (req.doc_type !== "QUOTE") return [buildNotification(action === "APPROVE" ? "APPROVED" : action === "RETURN" ? "RETURNED" : "REJECTED", req, req.prepared_by_email, b)];
  // Manager decisions. prepared_by is the Estimator who signed off; originator is the Rep. Each is told exactly once (a person who is both gets the Rep's message).
  if (action === "APPROVE") return uniq([req.prepared_by_email, rep]).map((to) => buildNotification(to === rep?.toLowerCase() ? "APPROVED_FOR_REP" : "APPROVED", req, to, b));
  if (action === "REJECT") return uniq([req.prepared_by_email, rep]).map((to) => buildNotification("REJECTED", req, to, b));
  if (destination === "ESTIMATOR") return uniq([req.prepared_by_email, rep]).map((to) => buildNotification(to === req.prepared_by_email.toLowerCase() ? "RETURNED_TO_ESTIMATOR" : "RETURNED_TO_ESTIMATOR_FOR_REP", req, to, b));
  return uniq([rep, req.prepared_by_email]).map((to) => buildNotification("RETURNED_TO_REP", req, to, b));
}

function matchesStagedTarget(action: ApprovalAction, destination: "ESTIMATOR" | "PREPARER" | null, snap: DocSnapshot): boolean {
  if (action === "RETURN" && destination === "ESTIMATOR") return snap.state === "UNSIGNED";
  return matchesTarget(action, snap);
}

/** The document's own existing action for a staged decision (each is a compare-and-set, so a concurrent second decision fails here). */
async function applyStagedDocumentAction(db: Db, ctx: ApprovalCtx, req: ApprovalRequestRow, action: ApprovalAction, reason: string, destination: "ESTIMATOR" | "PREPARER" | null): Promise<void> {
  if (req.doc_type !== "QUOTE") return applyDocumentAction(db, ctx, req, action, reason);
  const all = rolesFor("admin"); // the engine has already authorised this actor for this stage; the store re-checks state and content
  if ((req.stage ?? "MANAGER") === "ESTIMATOR") {
    if (action === "APPROVE") await estimatorSignOff(db, ctx.orgId, all, ctx.email, req.doc_id, evaluationContext(true));
    else if (action === "RETURN") await returnToRep(db, ctx.orgId, all, req.doc_id, reason);
    else if (action === "REJECT") await returnToRep(db, ctx.orgId, all, req.doc_id, `Rejected: ${reason}`);
    return;
  }
  if (action === "APPROVE") await managerApprove(db, ctx.orgId, all, ctx.email, req.doc_id, evaluationContext(true), evaluationContext(false));
  else if (action === "RETURN") { if (destination === "ESTIMATOR") await returnToEstimator(db, ctx.orgId, all, req.doc_id, reason); else await returnToRep(db, ctx.orgId, all, req.doc_id, reason); }
  else if (action === "REJECT") await returnToRep(db, ctx.orgId, all, req.doc_id, `Rejected: ${reason}`);
}

async function decideStaged(db: Db, ctx: ApprovalCtx, req: ApprovalRequestRow, action: ApprovalAction, input: { reason?: string; override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null; expectedVersion: number; expectedDigest: string }): Promise<ApprovalRequestRow> {
  const stage = req.stage ?? "MANAGER";
  const roles = await resolveRoles(db, ctx.orgId, ctx.userId, ctx.isManager);
  const sp = stageOf(await loadPolicies(db, ctx.orgId), req.doc_type, stage);
  const verdict = authoriseStageDecision({ email: ctx.email, roles, isAdmin: canAdminister(roles, ctx.isManager) }, action, req, (req.stage_role as typeof sp.role | null) ?? sp.role, input);
  if (!verdict.ok) fail(verdict.error);
  if (req.version !== input.expectedVersion || req.digest !== input.expectedDigest) fail("This submission changed while you were reviewing it. Reload and review the current revision before deciding.");
  const reason = (input.reason ?? "").trim();
  const destination = verdict.destination;
  if (action !== "WITHDRAW") {
    const snap = await loadSnapshot(db, ctx.orgId, req.doc_type, req.doc_id, stage);
    if (snap.digest !== req.digest) fail("The document has changed since it was submitted, so this submission can no longer be decided. Ask the preparer to resubmit the current revision.");
    if (snap.state === "SUBMITTABLE") await applyStagedDocumentAction(db, ctx, req, action, reason, destination);
    else if (!matchesStagedTarget(action, destination, snap)) fail(`The ${req.doc_type.toLowerCase()} is no longer waiting for ${stage === "ESTIMATOR" ? "estimator review" : "approval"} (${snap.stateLabel}).`);
    // else: already in the target state (a previous attempt changed it but could not record the decision): reconcile below
  }
  const r = await db.rpc("approval_decide_staged", {
    p_org: ctx.orgId, p_request: req.id, p_action: action, p_actor: ctx.email, p_actor_name: ctx.name, p_reason: reason || null, p_expected_version: input.expectedVersion,
    p_expected_digest: input.expectedDigest, p_override: verdict.override, p_destination: destination, p_notifications: stagedDecisionNotifications(action, req, ctx, reason, destination),
  });
  if (r.error) fail(r.error.message.replace(/^.*?(approval_[a-z_]+: )/, "").replace(/^approval: /, ""));
  const row = asRequest(r.data);
  await auditDemo(db, ctx, `approvals.${action.toLowerCase()}`, `${action} ${row.doc_type.toLowerCase()} ${row.doc_ref} at ${STAGE_LABEL[stage].toLowerCase()}`, row, { decisionAction: action, reason: reason || null, override: verdict.override, returnDestination: destination, decidedAtUtc: row.decided_at });
  await deliverForRequest(db, row.id).catch(() => undefined);
  // The next stage opens as a consequence of this decision. It is derived from the document, so decideDocument can also repair it if this step fails.
  if (req.doc_type === "QUOTE" && action !== "WITHDRAW") {
    try {
      if (stage === "ESTIMATOR" && action === "APPROVE") await submitStaged(db, ctx, "QUOTE", req.doc_id, { stage: "MANAGER", actor: { email: ctx.email, name: ctx.name } });
      else if (stage === "MANAGER" && action === "RETURN" && destination === "ESTIMATOR") {
        const holders = await emailsWithRole(db, ctx.orgId, "ESTIMATOR");
        await submitStaged(db, ctx, "QUOTE", req.doc_id, { stage: "ESTIMATOR", assignTo: holders.includes(req.prepared_by_email) ? req.prepared_by_email : null, quiet: true });
      }
    } catch (e) {
      throw new Error(`Your decision was recorded, but the next approval stage could not be opened (${(e as Error).message}). Open the quotation to continue.`);
    }
  }
  return row;
}

/**
 * Makes the open approval request match the quotation's current state: unsigned -> an ESTIMATOR-stage request on the current content; signed -> a MANAGER-stage
 * request. Idempotent; a request for older content is superseded. Called after the rep sends a quote to the estimator, after the content changes while in
 * review, and by decideDocument to repair a missing next stage.
 */
export async function resyncQuoteApprovals(db: Db, ctx: ApprovalCtx, quoteId: string, opts: { quiet?: boolean; actor?: { email: string; name: string } } = {}): Promise<ApprovalRequestRow | null> {
  if (!(await stagedAvailable(db))) return null;
  const signed = await loadSnapshot(db, ctx.orgId, "QUOTE", quoteId, "MANAGER");
  const wanted: ApprovalStage | null = signed.state === "SUBMITTABLE" ? "MANAGER" : signed.state === "UNSIGNED" ? "ESTIMATOR" : null;
  const pending = await pendingRequestFor(db, ctx.orgId, "QUOTE", quoteId);
  if (!wanted) { if (pending) await withdrawPendingFor(db, ctx, "QUOTE", quoteId, "The quotation is no longer in review."); return null; }
  const snap = wanted === "MANAGER" ? signed : await loadSnapshot(db, ctx.orgId, "QUOTE", quoteId, "ESTIMATOR");
  if (pending && pending.stage === wanted && pending.digest === snap.digest) return pending;
  if (wanted === "ESTIMATOR" && snap.state !== "SUBMITTABLE") return null;
  return submitStaged(db, ctx, "QUOTE", quoteId, { stage: wanted, quiet: opts.quiet, actor: opts.actor });
}
