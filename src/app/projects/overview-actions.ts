"use server";

// Projects - READ-ONLY Executive Overview data. Authorization is re-established inside the action (CCT-ADR-0010): module access, the NewQuip organisation
// gate, and the billing-scope guard; the frozen cost estimate is loaded ONLY for an org owner/admin (cost and margin never reach anyone else).
// Reads Supabase only: no Cin7 call, no write of any kind. Physical fulfilment from Cin7 is read separately through getPhysicalStatusAction.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
import { callerIsOrgAdmin, guardBillingScope } from "@/lib/projects/scope-access";
import { loadBaseCost } from "@/lib/newquip-quotes/project-estimated-cost";
import { loadOverviewData, type OverviewData } from "@/lib/projects/overview-store";

export interface OverviewDataResult {
  ok: boolean;
  error?: string;
  data?: OverviewData & { viewer: { isAdmin: boolean } };
}

export async function getProjectOverviewDataAction(projectId: string): Promise<OverviewDataResult> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    const db = createServiceRoleClient();
    const isAdmin = await callerIsOrgAdmin();
    await guardBillingScope(db, orgId, projectId, isAdmin);
    // The frozen cost estimate is not even read for a viewer who may not see cost.
    const base = isAdmin ? await loadBaseCost(db, orgId, projectId) : { estimatedCostCents: null, uncostedSellingCents: 0 };
    const data = await loadOverviewData(db, { orgId, projectId, isAdmin, base });
    return data ? { ok: true, data: { ...data, viewer: { isAdmin } } } : { ok: false, error: "Project not found." };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}
