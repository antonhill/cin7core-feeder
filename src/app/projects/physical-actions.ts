"use server";

// Projects - READ-ONLY physical visibility (ordered / invoiced / shipped / stock / assembly) of the linked Cin7 Sale. Authorization is
// re-established inside the action (CCT-ADR-0010). Reads Cin7 (GET only) and writes nothing anywhere.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { callerIsOrgAdmin, guardBillingScope } from "@/lib/projects/scope-access";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { buildPhysicalPort } from "@/lib/projects/physical-adapter";
import { loadPhysicalStatus } from "@/lib/projects/physical-store";
import { loadSaleLink } from "@/lib/projects/cin7-posting-store";
import type { PhysicalException, PhysicalRow } from "@/lib/projects/physical-status";

export interface PhysicalActionResult {
  ok: boolean;
  error?: string;
  data?: { linked: boolean; saleNumber?: string | null; rows?: PhysicalRow[]; exceptions?: PhysicalException[]; asOf?: string };
}

export async function getPhysicalStatusAction(projectId: string): Promise<PhysicalActionResult> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const db = createServiceRoleClient();
    await guardBillingScope(db, orgId, projectId, await callerIsOrgAdmin());
    const link = await loadSaleLink(db, orgId, projectId).catch(() => null);
    if (!link) return { ok: true, data: { linked: false } };
    const r = await loadPhysicalStatus(db, buildPhysicalPort(db, orgId, link.instance_id), { orgId, projectId });
    return { ok: true, data: r.linked ? { linked: true, saleNumber: r.saleNumber, rows: r.rows, exceptions: r.exceptions, asOf: r.asOf } : { linked: false } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}
