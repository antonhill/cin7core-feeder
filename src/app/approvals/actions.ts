"use server";

// NewQuip commercial approvals: Server Actions. Authorisation is re-established inside EVERY action: NewQuip organisation + Projects module access,
// then the caller's manager status is derived on the server (requireOrgAdmin); the browser's idea of who may click is never trusted. Approving
// authorises the commercial document ONLY: nothing here calls Cin7. This file exports only async functions and erased types.
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
import {
  approvalsAvailable, decide, docHistory, failedEmails, recentEmails, retryAndDispatchEmail, sendPendingNow, listRequests, loadRequest, loadSettings, managerEmails, markNotificationsRead, markViewed, myNotifications, reassign, requestHistory, submitForApproval,
  type ApprovalCtx,
} from "@/lib/approvals/approval-store";
import { emailConfigStatus, sendEmail } from "@/lib/email/resend";
import { applyEmailPolicy, approvalBaseUrl, displayEmailStatus, isRestricted, PREVIEW_EMAIL_ALLOWLIST } from "@/lib/approvals/email-policy";
import { resolveActing } from "@/lib/demo-mode/context";
import { buildReviewDetail, type ReviewDetail } from "@/lib/approvals/review-detail";
import { authoriseStageDecision } from "@/lib/approvals/policy";
import { canAdminister, STAGE_LABEL, type FunctionalRole } from "@/lib/approvals/roles";
import { emailsWithRole, resolveRoles } from "@/lib/approvals/role-store";
import { canSeeApprovalRequest, filterApprovalRequests, filterNotifications, guardQuote, quoteScope, type QuoteScope } from "@/lib/newquip-assignments/access";
import { filterQueue, sortQueue, summarise, currentReturned, type QueueFilters, type QueueSort, type QueueSummary } from "@/lib/approvals/queue";
import type { ApprovalAction, ApprovalDocType, ApprovalEventRow, ApprovalNotificationRow, ApprovalRequestRow, ApprovalSettings } from "@/lib/approvals/types";

export interface ApprovalResult<T> { ok: boolean; error?: string; data?: T }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

async function context(): Promise<ApprovalCtx> {
  // allowDemo: the approvals dashboard is one of the scoped quotation / approval surfaces; it acts as the EFFECTIVE user under the owner's Demo Mode.
  const real = await requireModuleAccess(PROJECTS_MODULE.href, { allowDemo: true });
  assertNewquipOrg(real.orgId);
  const acting = await resolveActing(real, PROJECTS_MODULE.href);
  let isManager = false;
  if (acting.demo) isManager = acting.tier === "admin"; // the effective user's OWN tier
  else { try { await requireOrgAdmin("manage approvals"); isManager = true; } catch { isManager = false; } } // fail closed
  const base = approvalBaseUrl(process.env);
  return { orgId: acting.orgId, userId: acting.userId, email: acting.email.toLowerCase(), name: acting.demo?.actorName ?? acting.email, isManager, baseUrl: base, ...(acting.demo ? { demo: acting.demo } : {}) };
}

type Db = ReturnType<typeof createServiceRoleClient>;
/** Rep isolation (Slice 1B): the actor's quotation scope (org-wide unless isolation is ON and they hold no org-wide role). */
const scopeFor = (db: Db, ctx: ApprovalCtx): Promise<QuoteScope> => quoteScope(db, { orgId: ctx.orgId, userId: ctx.userId, email: ctx.email, tier: ctx.isManager ? "admin" : "member" });
/** Loads one approval request ONLY if the actor may see it; otherwise the same "not found" as a missing id. */
async function visibleRequest(db: Db, ctx: ApprovalCtx, requestId: string): Promise<ApprovalRequestRow> {
  const req = await loadRequest(db, ctx.orgId, requestId);
  if (!req || !(await canSeeApprovalRequest(db, await scopeFor(db, ctx), req))) throw new Error("Approval request not found.");
  return req;
}
/** A document (quotation / claim / variation) the actor may act on or read approvals for: quotations through the customer rule; claims and variations are Project matters. */
async function visibleDocument(db: Db, ctx: ApprovalCtx, docType: ApprovalDocType, docId: string): Promise<void> {
  const scope = await scopeFor(db, ctx);
  if (scope.kind === "ORG_WIDE") return;
  if (docType !== "QUOTE") throw new Error("Not found.");
  await guardQuote(db, { orgId: ctx.orgId, userId: ctx.userId, email: ctx.email, tier: "member" }, docId);
}

/** Administrative approval operations (settings, email delivery) are never performed while a demo identity is active. */
function notInDemo(ctx: ApprovalCtx, what: string) {
  if (ctx.demo) throw new Error(`${what} is not available in Demo Mode. Exit Demo Mode first.`);
}

export interface ApprovalsDashboard {
  available: boolean; me: string; isManager: boolean; nowIso: string;
  summary: QueueSummary; rows: ApprovalRequestRow[]; needsPreparerAction: ApprovalRequestRow[];
  managers: string[]; failedEmails: ApprovalNotificationRow[]; /** the organisation's recent emails in every status (managers only) */ recentEmails: ApprovalNotificationRow[]; unread: number; settings: ApprovalSettings;
}

export async function getApprovalsDashboardAction(filters: QueueFilters = {}, sort: QueueSort = "submitted_desc"): Promise<ApprovalResult<ApprovalsDashboard>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    const nowIso = new Date().toISOString();
    if (!(await approvalsAvailable(db))) return { ok: true, data: { available: false, me: ctx.email, isManager: ctx.isManager, nowIso, summary: summarise([], ctx.email, nowIso), rows: [], needsPreparerAction: [], managers: [], failedEmails: [], recentEmails: [], unread: 0, settings: await loadSettings(db, ctx.orgId) } };
    const everything = await listRequests(db, ctx.orgId);
    const scope = await scopeFor(db, ctx);
    const all = await filterApprovalRequests(db, scope, everything);   // Rep isolation: only requests for quotations the actor may see
    const myRoles = await resolveRoles(db, ctx.orgId, ctx.userId, ctx.isManager);
    const notes = await filterNotifications(db, scope, await myNotifications(db, ctx.orgId, ctx.email, 200), everything);
    return { ok: true, data: {
      available: true, me: ctx.email, isManager: ctx.isManager, nowIso, summary: summarise(all, ctx.email, nowIso, myRoles), rows: sortQueue(filterQueue(all, filters, ctx.email, nowIso, myRoles), sort),
      needsPreparerAction: currentReturned(all).filter((r) => r.prepared_by_email === ctx.email), managers: ctx.isManager ? await managerEmails(db, ctx.orgId) : [],
      failedEmails: ctx.isManager ? await failedEmails(db, ctx.orgId) : [], recentEmails: ctx.isManager ? await recentEmails(db, ctx.orgId) : [], unread: notes.filter((n) => !n.read_at).length, settings: await loadSettings(db, ctx.orgId),
    } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export interface ApprovalDetail {
  request: ApprovalRequestRow; history: ApprovalEventRow[]; review: ReviewDetail; isManager: boolean; me: string;
  /** What this viewer may do right now (the server re-checks every action). */
  can: { decide: boolean; withdraw: boolean; reassign: boolean; needsOverride: boolean; returnToEstimator?: boolean };
  /** Who can be chosen as approver for this stage (holders of the stage's role; managers on a database without staged approvals). */
  managers: string[]; docHistoryAll: ApprovalEventRow[];
  stage?: { stage: "ESTIMATOR" | "MANAGER"; label: string; role: string };
}

export async function getApprovalDetailAction(requestId: string): Promise<ApprovalResult<ApprovalDetail>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    const req = await visibleRequest(db, ctx, requestId);   // Rep isolation: generic "not found" for a request the actor may not see
    if (req.status === "PENDING") await markViewed(db, ctx, requestId).catch(() => undefined);
    const pending = req.status === "PENDING";
    const self = req.prepared_by_email === ctx.email;
    if (req.stage !== undefined) {
      // Staged: what this viewer may do is derived from the SAME rules the decision itself enforces (the server re-checks on every action).
      const roles = await resolveRoles(db, ctx.orgId, ctx.userId, ctx.isManager);
      const actor = { email: ctx.email, roles, isAdmin: canAdminister(roles, ctx.isManager) };
      const role = (req.stage_role as FunctionalRole | null) ?? "MANAGER";
      const ok = (a: ApprovalAction, extra: { override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null } = {}) => authoriseStageDecision(actor, a, req, role, { reason: "probe reason", ...extra });
      const normalApprove = ok("APPROVE"); const overrideApprove = ok("APPROVE", { override: true });
      const canReturn = ok("RETURN").ok;
      return { ok: true, data: {
        request: (await loadRequest(db, ctx.orgId, requestId)) ?? req, history: await requestHistory(db, ctx.orgId, requestId), docHistoryAll: await docHistory(db, ctx.orgId, req.doc_type, req.doc_id),
        review: await buildReviewDetail(db, ctx.orgId, req, actor.isAdmin || roles.has("MANAGER")), isManager: actor.isAdmin || roles.has("MANAGER"), me: ctx.email,
        can: {
          decide: pending && (normalApprove.ok || overrideApprove.ok || canReturn), withdraw: pending && ok("WITHDRAW").ok,
          reassign: pending && (actor.isAdmin || roles.has("MANAGER") || (req.assigned_to_email ?? "") === ctx.email), needsOverride: pending && !normalApprove.ok && overrideApprove.ok,
          returnToEstimator: pending && canReturn && req.doc_type === "QUOTE" && req.stage === "MANAGER",
        },
        managers: pending ? await emailsWithRole(db, ctx.orgId, role) : [], stage: { stage: req.stage, label: STAGE_LABEL[req.stage], role },
      } };
    }
    return { ok: true, data: {
      request: (await loadRequest(db, ctx.orgId, requestId)) ?? req, history: await requestHistory(db, ctx.orgId, requestId), docHistoryAll: await docHistory(db, ctx.orgId, req.doc_type, req.doc_id),
      review: await buildReviewDetail(db, ctx.orgId, req, ctx.isManager), isManager: ctx.isManager, me: ctx.email,
      can: { decide: pending && ctx.isManager, withdraw: pending && (ctx.isManager || self), reassign: pending && ctx.isManager, needsOverride: pending && ctx.isManager && self },
      managers: ctx.isManager ? await managerEmails(db, ctx.orgId) : [],
    } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** A document's approval history (for the quote, claim and variation screens). Read-only. */
export async function getDocumentApprovalAction(docType: ApprovalDocType, docId: string): Promise<ApprovalResult<{ available: boolean; latest: ApprovalRequestRow | null; history: ApprovalEventRow[] }>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    if (!(await approvalsAvailable(db))) return { ok: true, data: { available: false, latest: null, history: [] } };
    await visibleDocument(db, ctx, docType, docId);
    const history = await docHistory(db, ctx.orgId, docType, docId);
    const all = (await listRequests(db, ctx.orgId)).filter((r) => r.doc_type === docType && r.doc_id === docId).sort((a, b) => b.revision - a.revision);
    return { ok: true, data: { available: true, latest: all[0] ?? null, history } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function submitDocumentForApprovalAction(docType: ApprovalDocType, docId: string, assignTo?: string): Promise<ApprovalResult<ApprovalRequestRow>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    if (!(await approvalsAvailable(db))) throw new Error("Approvals are not available yet (database migration pending).");
    await visibleDocument(db, ctx, docType, docId);
    const row = await submitForApproval(db, ctx, docType, docId, { assignTo });
    if (!ctx.demo) await logActivity(db, { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: "approvals.submitted", summary: `Submitted ${docType.toLowerCase()} ${row.doc_ref} (revision ${row.revision}) for approval (no Cin7 write)`, detail: { requestId: row.id, docType, docId, revision: row.revision } });
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function decideApprovalAction(requestId: string, action: ApprovalAction, input: { reason?: string; override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null; expectedVersion: number; expectedDigest: string }): Promise<ApprovalResult<ApprovalRequestRow>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    await visibleRequest(db, ctx, requestId);
    const row = await decide(db, ctx, requestId, action, input);
    if (!ctx.demo) await logActivity(db, { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: `approvals.${action.toLowerCase()}`, summary: `${action} ${row.doc_type.toLowerCase()} ${row.doc_ref} revision ${row.revision}${row.admin_override ? " (ADMIN OVERRIDE)" : ""} (approval only; no Cin7 write)`, detail: { requestId, docType: row.doc_type, docId: row.doc_id, revision: row.revision, reason: input.reason ?? null, override: row.admin_override } });
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function reassignApprovalAction(requestId: string, newApprover: string, expectedVersion: number): Promise<ApprovalResult<ApprovalRequestRow>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    await visibleRequest(db, ctx, requestId);
    return { ok: true, data: await reassign(db, ctx, requestId, newApprover, expectedVersion) };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function getMyNotificationsAction(markAllRead = false): Promise<ApprovalResult<{ notifications: ApprovalNotificationRow[]; unread: number }>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    // Rep isolation: filter FIRST, then mark only what the actor can see as read (never a row they cannot see).
    let notifications = await filterNotifications(db, await scopeFor(db, ctx), await myNotifications(db, ctx.orgId, ctx.email, 100), await listRequests(db, ctx.orgId));
    if (markAllRead) {
      const unread = notifications.filter((n) => !n.read_at).map((n) => n.id);
      if (unread.length) await markNotificationsRead(db, ctx.orgId, ctx.email, unread);
      notifications = notifications.map((n) => (n.read_at ? n : { ...n, read_at: new Date().toISOString() }));
    }
    return { ok: true, data: { notifications, unread: notifications.filter((n) => !n.read_at).length } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
export async function markNotificationReadAction(id: string): Promise<ApprovalResult<null>> {
  try {
    const ctx = await context();
    await markNotificationsRead(createServiceRoleClient(), ctx.orgId, ctx.email, [id]);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
export type DispatchSummary = { sent: number; failed: number; suppressed: number };
/** Manager only. Re-queues ONE failed email and dispatches exactly that row now (same policy, attempt cap and audit as every send). */
export async function retryEmailAction(notificationId: string): Promise<ApprovalResult<DispatchSummary>> {
  try {
    const ctx = await context();
    notInDemo(ctx, "Retrying an email");
    return { ok: true, data: await retryAndDispatchEmail(createServiceRoleClient(), ctx, notificationId) };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Manager only. Sends this organisation's QUEUED approval emails now. It never retries a FAILED row (that needs an explicit Retry). Cron does not run on a Preview. */
export async function sendPendingNowAction(): Promise<ApprovalResult<DispatchSummary>> {
  try {
    const ctx = await context();
    notInDemo(ctx, "Sending pending emails");
    return { ok: true, data: await sendPendingNow(createServiceRoleClient(), ctx) };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Manager only. Audited. Defaults: 2 business days, reminders every 24 h, at most 3. */
export async function saveApprovalSettingsAction(s: ApprovalSettings): Promise<ApprovalResult<null>> {
  try {
    const ctx = await context();
    notInDemo(ctx, "Changing approval settings");
    if (!ctx.isManager) throw new Error("Only a manager can change approval settings.");
    if (!Number.isInteger(s.targetBusinessDays) || s.targetBusinessDays < 1 || s.targetBusinessDays > 30) throw new Error("The approval target must be 1 to 30 business days.");
    if (!Number.isInteger(s.reminderEveryHours) || s.reminderEveryHours < 1 || s.reminderEveryHours > 720) throw new Error("Reminders must be 1 to 720 hours apart.");
    if (!Number.isInteger(s.maxReminders) || s.maxReminders < 0 || s.maxReminders > 20) throw new Error("The maximum number of reminders must be 0 to 20.");
    const db = createServiceRoleClient();
    if (s.escalationEmail && !(await managerEmails(db, ctx.orgId)).includes(s.escalationEmail.trim().toLowerCase())) throw new Error("The escalation contact must be a manager.");
    const r = await db.from("approval_settings").upsert({ org_id: ctx.orgId, target_business_days: s.targetBusinessDays, reminder_every_hours: s.reminderEveryHours, max_reminders: s.maxReminders, escalation_email: s.escalationEmail?.trim().toLowerCase() || null, updated_by_email: ctx.email, updated_at: new Date().toISOString() });
    if (r.error) throw new Error(r.error.message);
    await logActivity(db, { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: "approvals.settings_changed", summary: "Changed the approval target / reminder settings", detail: { ...s } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Manager only. Reports whether email can be sent (presence of the provider settings only; never the key). */
export async function getEmailStatusAction(): Promise<ApprovalResult<{ configured: boolean; missing: string[]; senderDomain: string | null; failed: number; abandoned: number; suppressed: number; restricted: boolean; allowlist: string[]; linkBase: string }>> {
  try {
    const ctx = await context();
    notInDemo(ctx, "The email delivery status");
    if (!ctx.isManager) throw new Error("Only a manager can see the email delivery status.");
    const failed = await failedEmails(createServiceRoleClient(), ctx.orgId);
    return { ok: true, data: { ...emailConfigStatus(), failed: failed.filter((n) => displayEmailStatus(n) === "FAILED").length, abandoned: failed.filter((n) => displayEmailStatus(n) === "ABANDONED").length, suppressed: failed.filter((n) => displayEmailStatus(n) === "SUPPRESSED").length, restricted: isRestricted(process.env), allowlist: isRestricted(process.env) ? [...PREVIEW_EMAIL_ALLOWLIST] : [], linkBase: approvalBaseUrl(process.env) } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/**
 * Manager only. Sends ONE test message to the caller's own address through the same provider path as approval emails, so provider acceptance can be
 * confirmed. The result states plainly whether the provider accepted it; a failure is never reported as sent. Creates no approval and writes nothing to Cin7.
 */
export async function sendTestEmailAction(): Promise<ApprovalResult<{ accepted: boolean; messageId?: string; error?: string; to: string; suppressed?: boolean }>> {
  try {
    const ctx = await context();
    notInDemo(ctx, "Sending a test email");
    if (!ctx.isManager) throw new Error("Only a manager can send a test email.");
    const decision = applyEmailPolicy(process.env, { to: ctx.email, subject: "NewQuip approvals: test email", text: `This is a test of the NewQuip approval email delivery, requested by ${ctx.email}. No action is needed.` });
    if (decision.action === "SUPPRESS") { await logActivity(createServiceRoleClient(), { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: "approvals.test_email", summary: "A test approval email was suppressed by the Preview policy", detail: { accepted: false, suppressed: true } }).catch(() => undefined); return { ok: true, data: { accepted: false, error: decision.reason, to: ctx.email, suppressed: true } }; }
    const res = await sendEmail({ to: [ctx.email], subject: decision.subject, text: decision.text });
    await logActivity(createServiceRoleClient(), { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: "approvals.test_email", summary: res.ok ? "Sent a test approval email (provider accepted)" : "A test approval email failed", detail: { accepted: res.ok } }).catch(() => undefined);
    return { ok: true, data: { accepted: res.ok, messageId: res.messageId, error: res.error, to: ctx.email } };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}
