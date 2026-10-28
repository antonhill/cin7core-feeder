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
import type { ProfitabilityReport } from "@/lib/projects/profitability";

export interface ProfitabilityActionResult {
  ok: boolean;
  error?: string;
  data?: ProfitabilityReport;
}

export async function getProfitabilityAction(projectId: string): Promise<ProfitabilityActionResult> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    await requireOrgAdmin("view project profitability");
    const db = createServiceRoleClient();
    const base = await loadBaseCost(db, orgId, projectId);
    const report = await loadProfitability(db, (instanceId) => buildPhysicalPort(db, orgId, instanceId), { orgId, projectId, base });
    return report ? { ok: true, data: report } : { ok: false, error: "Project not found." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}
