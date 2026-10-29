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
import { evaluationContext } from "@/lib/newquip-quotes/context";
import { managerApprove, returnToRep, loadQuote } from "@/lib/newquip-quotes/quote-store";
import { rolesFor } from "@/newquip/quote/roles";
import { approveClaim, cancelDraftClaim, returnClaimToDraft } from "@/lib/projects/project-store";
import { approveVariation, rejectVariation } from "@/lib/projects/variation-store";
import { listVariationStages } from "@/lib/projects/variation-billing-store";
import { authoriseDecision } from "./policy";
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

export interface ApprovalCtx { orgId: string; userId: string; email: string; name: string; isManager: boolean; baseUrl?: string }

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

export type DocState = "SUBMITTABLE" | "APPROVED" | "RETURNED" | "REJECTED" | "OTHER";
export interface DocSnapshot {
  docType: ApprovalDocType; docId: string; docRef: string; projectId: string | null; projectRef: string | null; customer: string | null; amountCents: number;
  preparedBy: string; digest: string; state: DocState; stateLabel: string;
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

export async function loadSnapshot(db: Db, orgId: string, docType: ApprovalDocType, docId: string): Promise<DocSnapshot> {
  if (docType === "QUOTE") {
    const q = await loadQuote(db, orgId, docId);
    if (!q) fail("Quote not found.");
    const proj = q.project_id ? await projectInfo(db, orgId, q.project_id) : null;
    const signed = q.state === "ESTIMATOR_REVIEW" && !!q.estimator_signoff_hash && q.estimator_signoff_hash === q.draft_hash && q.customer_confirmed_cents != null;
    const state: DocState = signed ? "SUBMITTABLE" : q.state === "MANAGER_APPROVED_FINAL" ? "APPROVED" : q.state === "REP_DRAFT" ? "RETURNED" : "OTHER";
    return {
      docType, docId, docRef: q.quote_ref, projectId: q.project_id, projectRef: proj?.ref ?? null, customer: q.customer_name, amountCents: q.customer_confirmed_cents ?? q.contract_cents ?? 0,
      preparedBy: (q.estimator_signoff_by_email ?? q.handoff_by_email ?? q.created_by_email ?? "unknown").toLowerCase(),
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
const newId = () => crypto.randomUUID();

/** Submits the CURRENT revision of a document. Records the exact digest and amount; identical content already pending is a no-op; changed content supersedes the pending submission. */
export async function submitForApproval(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string, opts: { assignTo?: string | null; now?: Date; actor?: { email: string; name: string } } = {}): Promise<ApprovalRequestRow> {
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

export async function decide(db: Db, ctx: ApprovalCtx, requestId: string, action: ApprovalAction, input: { reason?: string; override?: boolean; expectedVersion: number; expectedDigest: string }): Promise<ApprovalRequestRow> {
  const req = await loadRequest(db, ctx.orgId, requestId);
  if (!req) fail("Approval request not found.");
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
  if (!ctx.isManager) fail("Only a manager can reassign an approval.");
  const req = await loadRequest(db, ctx.orgId, requestId);
  if (!req) fail("Approval request not found.");
  if (req.status !== "PENDING") fail(`This submission is already ${req.status.toLowerCase()}.`);
  const to = newApprover.trim().toLowerCase();
  if (!(await managerEmails(db, ctx.orgId)).includes(to)) fail("The new approver must be a manager (organisation owner or admin).");
  const specs: NotificationSpec[] = [buildNotification("REASSIGNED", req, to, { baseUrl: ctx.baseUrl, by: ctx.name, newApprover: to })];
  if (req.assigned_to_email && req.assigned_to_email !== to) specs.push(buildNotification("REASSIGNED_AWAY", req, req.assigned_to_email, { baseUrl: ctx.baseUrl, by: ctx.name, newApprover: to }));
  const r = await db.rpc("approval_reassign", { p_org: ctx.orgId, p_request: requestId, p_new: to, p_actor: ctx.email, p_actor_name: ctx.name, p_expected_version: expectedVersion, p_notifications: specs });
  if (r.error) fail(r.error.message);
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

const emailTargets = (db: Db) => db.from("approval_notifications").select("*").eq("channel", "EMAIL").in("status", ["PENDING", "FAILED"]);

async function deliverRows(db: Db, rows: ApprovalNotificationRow[], send: typeof sendEmail): Promise<{ sent: number; failed: number }> {
  let sent = 0; let failed = 0;
  for (const row of rows) {
    const n = { ...row }; // work on a copy: the attempt counter we compare-and-set against must not move under us
    if (n.attempts >= MAX_EMAIL_ATTEMPTS) continue;
    // claim the attempt (compare-and-set on the attempt counter): two workers never send the same notification twice
    const claim = await db.from("approval_notifications").update({ attempts: n.attempts + 1 }).eq("id", n.id).eq("attempts", n.attempts).in("status", ["PENDING", "FAILED"]).select("id");
    if (claim.error || !claim.data?.length) continue;
    const res = await send({ to: [n.recipient_email], subject: n.subject, text: n.body });
    if (res.ok) {
      await db.from("approval_notifications").update({ status: "SENT", sent_at: new Date().toISOString(), provider_message_id: res.messageId ?? null, last_error: null }).eq("id", n.id);
      sent += 1;
    } else {
      const exhausted = n.attempts + 1 >= MAX_EMAIL_ATTEMPTS;
      await db.from("approval_notifications").update({ status: exhausted ? "ABANDONED" : "FAILED", last_error: (res.error ?? "unknown error").slice(0, 500) }).eq("id", n.id);
      failed += 1;
    }
  }
  return { sent, failed };
}
export async function deliverForRequest(db: Db, requestId: string, send: typeof sendEmail = sendEmail) {
  const r = await emailTargets(db).eq("request_id", requestId);
  if (r.error) return { sent: 0, failed: 0 };
  return deliverRows(db, (r.data ?? []) as ApprovalNotificationRow[], send);
}
/** The cron entry: bounded batch across organisations. SENT is recorded only when the provider accepted the message. */
export async function deliverPendingEmails(db: Db, send: typeof sendEmail = sendEmail, limit = 50) {
  const r = await emailTargets(db);
  if (r.error) { if (missing(r.error.message)) return { sent: 0, failed: 0 }; fail(r.error.message); }
  return deliverRows(db, ((r.data ?? []) as ApprovalNotificationRow[]).sort((a, b) => a.created_at.localeCompare(b.created_at)).slice(0, limit), send);
}
/** Administrative retry of an email that failed or was abandoned. */
export async function retryEmail(db: Db, ctx: ApprovalCtx, notificationId: string): Promise<void> {
  if (!ctx.isManager) fail("Only a manager can retry a notification.");
  const r = await db.from("approval_notifications").update({ status: "PENDING", attempts: 0, last_error: null }).eq("org_id", ctx.orgId).eq("id", notificationId).eq("channel", "EMAIL").in("status", ["FAILED", "ABANDONED"]).select("id");
  if (r.error) fail(r.error.message);
  if (!r.data?.length) fail("That notification is not a failed email.");
}
export async function failedEmails(db: Db, orgId: string): Promise<ApprovalNotificationRow[]> {
  const r = await db.from("approval_notifications").select("*").eq("org_id", orgId).eq("channel", "EMAIL").in("status", ["FAILED", "ABANDONED"]);
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
    const mgrs = managersCache.get(req.org_id) ?? (await managerEmails(db, req.org_id)); managersCache.set(req.org_id, mgrs);
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

export function legacyCtx(orgId: string, userId: string, email: string | null, isManager: boolean): ApprovalCtx {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return { orgId, userId, email: (email ?? "unknown").toLowerCase(), name: email ?? "unknown", isManager, baseUrl: base };
}

/**
 * A decision made from a document's own screen. The current revision is submitted first when nobody submitted it (recorded as submitted by its
 * preparer), then decided through the same checks as the Approvals dashboard: separation of duties, exact digest, history, notifications.
 */
export async function decideDocument(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string, action: Exclude<ApprovalAction, "WITHDRAW">, input: { reason?: string; override?: boolean } = {}): Promise<ApprovalRequestRow> {
  let req = await pendingRequestFor(db, ctx.orgId, docType, docId);
  if (!req) {
    const snap = await loadSnapshot(db, ctx.orgId, docType, docId);
    req = await submitForApproval(db, ctx, docType, docId, { actor: { email: snap.preparedBy, name: snap.preparedBy } });
  }
  return decide(db, ctx, req.id, action, { ...input, expectedVersion: req.version, expectedDigest: req.digest });
}

/** The preparer (or a manager) takes a document out of review by editing/cancelling it elsewhere: the pending submission is withdrawn, never left dangling. */
export async function withdrawPendingFor(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string, reason: string): Promise<void> {
  const req = await pendingRequestFor(db, ctx.orgId, docType, docId).catch(() => null);
  if (!req) return;
  const r = await db.rpc("approval_decide", { p_org: ctx.orgId, p_request: req.id, p_action: "WITHDRAW", p_actor: ctx.email, p_actor_name: ctx.name, p_reason: reason, p_expected_version: req.version, p_expected_digest: req.digest, p_override: false, p_notifications: [] });
  if (r.error) fail(r.error.message);
}
