"use server";

// Projects - consolidated PROFITABILITY and reconciliation. INTERNAL (contains cost and margin): org owner/admin only, re-checked here.
// Reads Supabase and Cin7 (GET only); writes nothing anywhere.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { buildPhysicalPort } from "@/lib/projects/physical-adapter";
import { loadProfitability } from "@/lib/projects/profitability-store";
import { loadBaseCost } from "@/lib/newquip-quotes/project-estimated-cost";
import { logActivity } from "@/lib/activity-log";
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
import { guardBillingScope } from "@/lib/projects/scope-access";
import { addCostEntry, loadCostLedger, markCostIncurred, voidCostEntry } from "@/lib/projects/project-costs-store";
import { loadCostingReport } from "@/lib/newquip-quotes/costing-report-store";
import type { CostingReport } from "@/lib/projects/costing-report";
import type { CostEntry, CostTotals, NewCostInput } from "@/lib/projects/project-costs";
import type { ProfitabilityReport } from "@/lib/projects/profitability";

export interface ProfitabilityActionResult {
  ok: boolean;
  error?: string;
  data?: ProfitabilityReport;
}

export async function getProfitabilityAction(projectId: string): Promise<ProfitabilityActionResult> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href, { projectData: true });
    await requireOrgAdmin("view project profitability");
    const db = createServiceRoleClient();
    const base = await loadBaseCost(db, orgId, projectId);
    const report = await loadProfitability(db, (instanceId) => buildPhysicalPort(db, orgId, instanceId), { orgId, projectId, base });
    return report ? { ok: true, data: report } : { ok: false, error: "Project not found." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}

// ── direct non-stock project costs (INTERNAL: owner/admin only; NewQuip only) ───────────────────────────────

export interface CostLedgerResult { ok: boolean; error?: string; data?: { available: boolean; entries: CostEntry[]; totals: CostTotals | null } }
const msg = (e: unknown) => (e instanceof Error ? e.message : "Unexpected error");

async function costContext(projectId: string) {
  const { orgId, userId, email } = await requireModuleAccess(PROJECTS_MODULE.href, { projectData: true });
  assertNewquipOrg(orgId);
  await requireOrgAdmin("manage project costs");
  const db = createServiceRoleClient();
  await guardBillingScope(db, orgId, projectId, true);
  return { orgId, userId, email: email ?? "unknown", db };
}

export async function getCostLedgerAction(projectId: string): Promise<CostLedgerResult> {
  try {
    const { orgId, db } = await costContext(projectId);
    const l = await loadCostLedger(db, orgId, projectId);
    return { ok: true, data: l ? { available: true, entries: l.entries, totals: l.totals } : { available: false, entries: [], totals: null } };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function addCostEntryAction(projectId: string, cost: NewCostInput): Promise<CostLedgerResult> {
  try {
    const { orgId, userId, email, db } = await costContext(projectId);
    const e = await addCostEntry(db, { orgId, projectId, actor: email, cost });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.cost_recorded", summary: `Recorded a ${e.state.toLowerCase()} ${e.category.toLowerCase()} cost`, detail: { projectId, entryId: e.id, category: e.category, amountCents: e.amount_cents, state: e.state, inCin7Valuation: e.in_cin7_valuation } });
    return { ok: true };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function markCostIncurredAction(projectId: string, entryId: string, incurredOn?: string): Promise<CostLedgerResult> {
  try {
    const { orgId, userId, email, db } = await costContext(projectId);
    await markCostIncurred(db, { orgId, projectId, entryId, incurredOn });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.cost_incurred", summary: "Marked a committed cost as incurred", detail: { projectId, entryId } });
    return { ok: true };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

export async function voidCostEntryAction(projectId: string, entryId: string, reason: string): Promise<CostLedgerResult> {
  try {
    const { orgId, userId, email, db } = await costContext(projectId);
    await voidCostEntry(db, { orgId, projectId, entryId, actor: email, reason });
    await logActivity(db, { orgId, actor: { userId, email }, action: "projects.cost_voided", summary: "Voided a project cost entry", detail: { projectId, entryId, reason } });
    return { ok: true };
  } catch (e) { return { ok: false, error: msg(e) }; }
}

/** INTERNAL (owner/admin): estimated vs actual cost by SKU, section, stage, supplier and scope, budget variance and expected final margin. Reads Cin7 (GET only). */
export async function getCostingReportAction(projectId: string): Promise<{ ok: boolean; error?: string; data?: CostingReport }> {
  try {
    const { orgId, db } = await costContext(projectId);
    const r = await loadCostingReport(db, (instanceId) => buildPhysicalPort(db, orgId, instanceId), { orgId, projectId });
    return r ? { ok: true, data: r } : { ok: false, error: "Project not found." };
  } catch (e) { return { ok: false, error: msg(e) }; }
}
