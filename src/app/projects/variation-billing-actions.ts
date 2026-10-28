"use server";

// Projects - variation BILLING Server Actions. LOCAL ONLY: nothing here reaches Cin7 (the variation's Cin7 Sale is linked and posted through
// cin7-actions.ts, behind its own gates). Authorization is re-established inside EVERY action (CCT-ADR-0010): module access for reads and
// draft schedule edits; org owner/admin (manager) for starting billing and for any amendment.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { logActivity } from "@/lib/activity-log";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { amendVariationSchedule, createVariationBillingProject, listVariationStages, loadConsolidatedProject, saveDraftSchedule, type ConsolidatedProject } from "@/lib/projects/variation-billing-store";
import { callerIsOrgAdmin } from "@/lib/projects/scope-access";
import { scheduleFromPercents } from "@/lib/projects/variation-schedule";

export interface VariationBillingResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}
export interface VariationBillingState {
  consolidated: ConsolidatedProject;
  schedules: Record<string, Array<{ name: string; bps: number }>>;
  billingProjectByVariation: Record<string, string>;
}
export interface SchedulePercentRow { name: string; percent: string }

const message = (e: unknown): string => (e instanceof Error ? e.message : "Unexpected error");

export async function getVariationBillingAction(projectId: string): Promise<VariationBillingResult<VariationBillingState>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const db = createServiceRoleClient();
    const admin = await callerIsOrgAdmin();
    const consolidated = await loadConsolidatedProject(db, orgId, projectId);
    if (!consolidated) return { ok: false, error: "Project not found." };
    const schedules: VariationBillingState["schedules"] = {};
    for (const v of consolidated.base.variations) schedules[v.id] = (await listVariationStages(db, orgId, v.id)).map((s) => ({ name: s.name, bps: s.bps }));
    const billingProjectByVariation: Record<string, string> = {};
    for (const s of consolidated.scopes) {
      const vid = consolidated.base.variations.find((v) => v.code === s.variationCode)?.id;
      if (s.scope === "VARIATION" && vid) billingProjectByVariation[vid] = s.projectId;
    }
    return { ok: true, data: { consolidated: { ...consolidated, closureBlockers: admin ? consolidated.closureBlockers : [] }, schedules, billingProjectByVariation } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Any module member may edit a DRAFT variation's schedule (the estimator prices it); it is validated to total exactly 100%. */
export async function saveVariationScheduleAction(projectId: string, variationId: string, rows: SchedulePercentRow[]): Promise<VariationBillingResult<null>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await saveDraftSchedule(createServiceRoleClient(), orgId, projectId, variationId, scheduleFromPercents(rows));
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. Creates the variation's billing project (its own stages, from the frozen schedule). Idempotent. No Cin7 call. */
export async function startVariationBillingAction(projectId: string, variationId: string): Promise<VariationBillingResult<{ billingProjectId: string; created: boolean }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await requireOrgAdmin("start variation billing");
    const db = createServiceRoleClient();
    const r = await createVariationBillingProject(db, { isManager: true }, email ?? "unknown", { orgId, projectId, variationId });
    if (r.created) await logActivity(db, { orgId, actor: { userId, email }, action: "projects.variation_billing_started", summary: "Started billing for an approved variation (separate billing project; no Cin7 write)", detail: { projectId, variationId, billingProjectId: r.billingProjectId } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. The audited, controlled post-approval change (also how a variation approved before schedules existed first gets one). */
export async function amendVariationScheduleAction(projectId: string, variationId: string, rows: SchedulePercentRow[], reason: string): Promise<VariationBillingResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    await requireOrgAdmin("amend a variation billing schedule");
    const db = createServiceRoleClient();
    await amendVariationSchedule(db, { isManager: true }, email ?? "unknown", { orgId, projectId, variationId, stages: scheduleFromPercents(rows), reason });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.variation_schedule_amended", summary: "Amended an approved variation's billing schedule (audited; no Cin7 write)", detail: { projectId, variationId, reason } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
