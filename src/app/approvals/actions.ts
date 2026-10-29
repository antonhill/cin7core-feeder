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
  approvalsAvailable, decide, docHistory, failedEmails, listRequests, loadRequest, loadSettings, managerEmails, markNotificationsRead, markViewed, myNotifications, reassign, requestHistory, retryEmail, submitForApproval,
  type ApprovalCtx,
} from "@/lib/approvals/approval-store";
import { buildReviewDetail, type ReviewDetail } from "@/lib/approvals/review-detail";
import { authoriseStageDecision } from "@/lib/approvals/policy";
import { canAdminister, STAGE_LABEL, type FunctionalRole } from "@/lib/approvals/roles";
import { emailsWithRole, resolveRoles } from "@/lib/approvals/role-store";
import { filterQueue, sortQueue, summarise, currentReturned, type QueueFilters, type QueueSort, type QueueSummary } from "@/lib/approvals/queue";
import type { ApprovalAction, ApprovalDocType, ApprovalEventRow, ApprovalNotificationRow, ApprovalRequestRow, ApprovalSettings } from "@/lib/approvals/types";

export interface ApprovalResult<T> { ok: boolean; error?: string; data?: T }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

async function context(): Promise<ApprovalCtx> {
  const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
  assertNewquipOrg(orgId);
  let isManager = false;
  try { await requireOrgAdmin("manage approvals"); isManager = true; } catch { isManager = false; } // fail closed
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "");
  return { orgId, userId, email: (email ?? "unknown").toLowerCase(), name: email ?? "unknown", isManager, baseUrl: base };
}

export interface ApprovalsDashboard {
  available: boolean; me: string; isManager: boolean; nowIso: string;
  summary: QueueSummary; rows: ApprovalRequestRow[]; needsPreparerAction: ApprovalRequestRow[];
  managers: string[]; failedEmails: ApprovalNotificationRow[]; unread: number; settings: ApprovalSettings;
}

export async function getApprovalsDashboardAction(filters: QueueFilters = {}, sort: QueueSort = "submitted_desc"): Promise<ApprovalResult<ApprovalsDashboard>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    const nowIso = new Date().toISOString();
    if (!(await approvalsAvailable(db))) return { ok: true, data: { available: false, me: ctx.email, isManager: ctx.isManager, nowIso, summary: summarise([], ctx.email, nowIso), rows: [], needsPreparerAction: [], managers: [], failedEmails: [], unread: 0, settings: await loadSettings(db, ctx.orgId) } };
    const all = await listRequests(db, ctx.orgId);
    const myRoles = await resolveRoles(db, ctx.orgId, ctx.userId, ctx.isManager);
    const notes = await myNotifications(db, ctx.orgId, ctx.email, 200);
    return { ok: true, data: {
      available: true, me: ctx.email, isManager: ctx.isManager, nowIso, summary: summarise(all, ctx.email, nowIso, myRoles), rows: sortQueue(filterQueue(all, filters, ctx.email, nowIso, myRoles), sort),
      needsPreparerAction: currentReturned(all).filter((r) => r.prepared_by_email === ctx.email), managers: ctx.isManager ? await managerEmails(db, ctx.orgId) : [],
      failedEmails: ctx.isManager ? await failedEmails(db, ctx.orgId) : [], unread: notes.filter((n) => !n.read_at).length, settings: await loadSettings(db, ctx.orgId),
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
    const req = await loadRequest(db, ctx.orgId, requestId);
    if (!req) return { ok: false, error: "Approval request not found." };
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
    const row = await submitForApproval(db, ctx, docType, docId, { assignTo });
    await logActivity(db, { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: "approvals.submitted", summary: `Submitted ${docType.toLowerCase()} ${row.doc_ref} (revision ${row.revision}) for approval (no Cin7 write)`, detail: { requestId: row.id, docType, docId, revision: row.revision } });
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function decideApprovalAction(requestId: string, action: ApprovalAction, input: { reason?: string; override?: boolean; destination?: "ESTIMATOR" | "PREPARER" | null; expectedVersion: number; expectedDigest: string }): Promise<ApprovalResult<ApprovalRequestRow>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    const row = await decide(db, ctx, requestId, action, input);
    await logActivity(db, { orgId: ctx.orgId, actor: { userId: ctx.userId, email: ctx.email }, action: `approvals.${action.toLowerCase()}`, summary: `${action} ${row.doc_type.toLowerCase()} ${row.doc_ref} revision ${row.revision}${row.admin_override ? " (ADMIN OVERRIDE)" : ""} (approval only; no Cin7 write)`, detail: { requestId, docType: row.doc_type, docId: row.doc_id, revision: row.revision, reason: input.reason ?? null, override: row.admin_override } });
    return { ok: true, data: row };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function reassignApprovalAction(requestId: string, newApprover: string, expectedVersion: number): Promise<ApprovalResult<ApprovalRequestRow>> {
  try {
    const ctx = await context();
    return { ok: true, data: await reassign(createServiceRoleClient(), ctx, requestId, newApprover, expectedVersion) };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

export async function getMyNotificationsAction(markAllRead = false): Promise<ApprovalResult<{ notifications: ApprovalNotificationRow[]; unread: number }>> {
  try {
    const ctx = await context();
    const db = createServiceRoleClient();
    if (markAllRead) await markNotificationsRead(db, ctx.orgId, ctx.email, "ALL");
    const notifications = await myNotifications(db, ctx.orgId, ctx.email, 100);
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
export async function retryEmailAction(notificationId: string): Promise<ApprovalResult<null>> {
  try {
    const ctx = await context();
    await retryEmail(createServiceRoleClient(), ctx, notificationId);
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: msg(e) };
  }
}

/** Manager only. Audited. Defaults: 2 business days, reminders every 24 h, at most 3. */
export async function saveApprovalSettingsAction(s: ApprovalSettings): Promise<ApprovalResult<null>> {
  try {
    const ctx = await context();
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
