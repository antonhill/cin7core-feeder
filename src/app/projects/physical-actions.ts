"use server";

// Projects - READ-ONLY "Products & Fulfilment": the approved product scope against what Cin7 actually holds (ordered / invoiced / shipped / stock /
// assembly), for the original project and each approved variation scope. Authorization is re-established inside the action (CCT-ADR-0010).
// Reads Cin7 (GET only) and writes nothing anywhere.
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).

import { requireModuleAccess } from "@/lib/authorization";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { callerIsOrgAdmin, guardBillingScope } from "@/lib/projects/scope-access";
import { buildPhysicalPort } from "@/lib/projects/physical-adapter";
import { loadPhysicalStatus, type PhysicalPort } from "@/lib/projects/physical-store";
import { loadSaleLink } from "@/lib/projects/cin7-posting-store";
import type { PhysicalException, PhysicalRow } from "@/lib/projects/physical-status";

export interface ProductsSection {
  label: string;
  scope: "BASE" | "VARIATION";
  linked: boolean;
  saleNumber: string | null;
  rows: PhysicalRow[];
  exceptions: PhysicalException[];
  /** Approved-scope items still unmapped (they cannot be on a Sales Order until a manager resolves them). */
  scopeBlockers: string[];
  asOf: string;
}
export interface PhysicalActionResult {
  ok: boolean;
  error?: string;
  data?: { sections: ProductsSection[] };
}

const NO_CIN7: PhysicalPort = {
  async readSale() { throw new Error("no Cin7 Sale is linked"); },
  async readStock() { throw new Error("no Cin7 Sale is linked"); },
  async readAssemblies() { throw new Error("no Cin7 Sale is linked"); },
};

export async function getPhysicalStatusAction(projectId: string): Promise<PhysicalActionResult> {
  try {
    const { orgId } = await requireModuleAccess(PROJECTS_MODULE.href);
    const db = createServiceRoleClient();
    await guardBillingScope(db, orgId, projectId, await callerIsOrgAdmin());
    const section = async (id: string, label: string, scope: "BASE" | "VARIATION"): Promise<ProductsSection> => {
      const link = await loadSaleLink(db, orgId, id).catch(() => null);
      const r = await loadPhysicalStatus(db, link ? buildPhysicalPort(db, orgId, link.instance_id) : NO_CIN7, { orgId, projectId: id });
      return { label, scope, linked: r.linked, saleNumber: r.saleNumber, rows: r.rows, exceptions: r.exceptions, scopeBlockers: r.scopeBlockers, asOf: r.asOf };
    };
    const self = await db.from("projects").select("*").eq("org_id", orgId).eq("id", projectId).maybeSingle();
    if (self.error) throw new Error(self.error.message);
    const row = self.data as { project_reference: string; billing_scope?: string } | null;
    if (!row) throw new Error("Project not found.");
    const sections: ProductsSection[] = [await section(projectId, row.billing_scope === "VARIATION" ? "Variation scope" : "Original contract", row.billing_scope === "VARIATION" ? "VARIATION" : "BASE")];
    // A parent also reports each variation billing scope (internal operation, shown through the parent).
    if (row.billing_scope !== "VARIATION") {
      const kids = await db.from("projects").select("*").eq("org_id", orgId).eq("parent_project_id", projectId);
      if (!kids.error) for (const k of (kids.data ?? []) as Array<{ id: string; project_reference: string }>) sections.push(await section(k.id, `Variation ${k.project_reference.split("-").at(-1)}`, "VARIATION"));
    }
    return { ok: true, data: { sections } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}
