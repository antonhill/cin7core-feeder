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
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
import type { ConsolidatedCommercial } from "@/lib/projects/consolidated-report";
import { amendVariationSchedule, createVariationBillingProject, loadConsolidatedCommercial, listVariationStages, loadConsolidatedProject, loadReconciliationByProject, reconciliationByVariation, loadSaleNumbersByProject, saleNumbersByVariation, saveDraftSchedule, type ConsolidatedProject } from "@/lib/projects/variation-billing-store";
import type { ReconciliationSummary } from "@/lib/projects/variation-billing-store";
import { resolveVariationProducts, searchCatalogue, type CatalogueResult } from "@/lib/projects/catalogue-search";
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
  /** variation id -> the Cin7 Sale number already stored for its billing project; absent when none is linked. Read from stored links only. */
  saleNumberByVariation: Record<string, string | null>;
  /** True when the Sale-number lookup itself failed: the panel must then say the number is unavailable, never that no Sale exists. */
  saleLookupFailed?: boolean;
  /** variation id -> the reconciliation state recorded against ITS OWN billing project's Cin7 invoices (read-only; separate from claim approval). Absent when billing has not started. */
  reconciliationByVariation: Record<string, ReconciliationSummary>;
  /** True when that read failed: the panel must say the state is unavailable, never "nothing to reconcile". */
  reconciliationLookupFailed?: boolean;
}
export interface SchedulePercentRow { name: string; percent: string }

const message = (e: unknown): string => (e instanceof Error ? e.message : "Unexpected error");

export async function getVariationBillingAction(projectId: string): Promise<VariationBillingResult<VariationBillingState>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
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
    // The Sale number is a convenience read: if it cannot be loaded the billing state (and its decision controls) must still load, but the panel is told so and says
    // "unavailable" rather than "not created yet".
    let saleNumberByVariation: Record<string, string | null> = {};
    let saleLookupFailed = false;
    try {
      saleNumberByVariation = saleNumbersByVariation(billingProjectByVariation, await loadSaleNumbersByProject(db, orgId, Object.values(billingProjectByVariation)));
    } catch (e) {
      saleLookupFailed = true;
      console.error("variation billing: Cin7 Sale number lookup failed", message(e));
    }
    // Same rule for the reconciliation state: a failed read must not break the page or pose as "nothing to reconcile".
    let reconciliation: VariationBillingState["reconciliationByVariation"] = {};
    let reconciliationLookupFailed = false;
    try {
      reconciliation = reconciliationByVariation(billingProjectByVariation, await loadReconciliationByProject(db, orgId, Object.values(billingProjectByVariation)));
    } catch (e) {
      reconciliationLookupFailed = true;
      console.error("variation billing: invoice reconciliation lookup failed", message(e));
    }
    return { ok: true, data: { consolidated: { ...consolidated, closureBlockers: admin ? consolidated.closureBlockers : [] }, schedules, billingProjectByVariation, saleNumberByVariation, saleLookupFailed, reconciliationByVariation: reconciliation, reconciliationLookupFailed } };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Any module member may edit a DRAFT variation's schedule (the estimator prices it); it is validated to total exactly 100%. */
export async function saveVariationScheduleAction(projectId: string, variationId: string, rows: SchedulePercentRow[]): Promise<VariationBillingResult<null>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    await saveDraftSchedule(createServiceRoleClient(), orgId, projectId, variationId, scheduleFromPercents(rows));
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. Creates the variation's billing project (its own stages, from the frozen schedule). Idempotent. No Cin7 call. */
export async function startVariationBillingAction(projectId: string, variationId: string, products: Array<{ sku: string; description: string; quantity: number }> = []): Promise<VariationBillingResult<{ billingProjectId: string; created: boolean }>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    await requireOrgAdmin("start variation billing");
    const db = createServiceRoleClient();
    // Each pick is verified against the synced Cin7 catalogue and described from it (never from the browser); none = service-only.
    const verified = await resolveVariationProducts(db, orgId, products.map((p) => ({ sku: p.sku, quantity: p.quantity })));
    const r = await createVariationBillingProject(db, { isManager: true }, email ?? "unknown", { orgId, projectId, variationId, products: verified });
    if (r.created) await logActivity(db, { orgId, actor: { userId, email }, action: "projects.variation_billing_started", summary: "Started billing for an approved variation (separate billing project; no Cin7 write)", detail: { projectId, variationId, billingProjectId: r.billingProjectId, skus: verified.map((p) => p.sku), serviceOnly: verified.length === 0 } });
    return { ok: true, data: r };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Read-only (no Cin7 call): contract, claims and Cin7 invoices of the original project and every variation, each counted once. */
export async function getConsolidatedCommercialAction(projectId: string): Promise<VariationBillingResult<ConsolidatedCommercial>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    const db = createServiceRoleClient();
    const r = await loadConsolidatedCommercial(db, orgId, projectId);
    return r ? { ok: true, data: r } : { ok: false, error: "Project not found." };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Search the synced Cin7 catalogue by SKU or description (read-only, org-scoped, NewQuip only). Stock is shown, never required. */
export async function searchVariationProductsAction(query: string): Promise<VariationBillingResult<CatalogueResult>> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    await requireOrgAdmin("search products for a variation");
    return { ok: true, data: await searchCatalogue(createServiceRoleClient(), orgId, query) };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

/** Manager only. The audited, controlled post-approval change (also how a variation approved before schedules existed first gets one). */
export async function amendVariationScheduleAction(projectId: string, variationId: string, rows: SchedulePercentRow[], reason: string): Promise<VariationBillingResult<null>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    await requireOrgAdmin("amend a variation billing schedule");
    const db = createServiceRoleClient();
    await amendVariationSchedule(db, { isManager: true }, email ?? "unknown", { orgId, projectId, variationId, stages: scheduleFromPercents(rows), reason });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.variation_schedule_amended", summary: "Amended an approved variation's billing schedule (audited; no Cin7 write)", detail: { projectId, variationId, reason } });
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}
