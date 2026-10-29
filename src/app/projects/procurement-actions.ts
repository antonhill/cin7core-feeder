"use server";

// Projects - READ-ONLY "Procurement / Cost Targets": for a buyer, each physical SKU of the frozen approved scope with the cost the estimate ALLOWED, today's Cin7
// latest cost and the difference. Reads Cin7 (GET only) and writes nothing anywhere. Authorisation is re-established here: NewQuip org + Projects access, then the
// caller must be an organisation owner/admin, a Manager or a Procurement role holder (the target view carries unit costs but never the contract margin).
// This file may export ONLY async functions and erased interfaces ("use server" rule in CLAUDE.md).
import { requireModuleAccess } from "@/lib/authorization";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { createServiceRoleClient } from "@/supabase/server";
import { PROJECTS_MODULE } from "@/app/module-nav";
import { assertNewquipOrg } from "@/lib/projects/newquip-gate";
import { guardBillingScope } from "@/lib/projects/scope-access";
import { buildPhysicalPort } from "@/lib/projects/physical-adapter";
import { loadPhysicalStatus, type PhysicalPort } from "@/lib/projects/physical-store";
import { loadSaleLink } from "@/lib/projects/cin7-posting-store";
import { effectiveScope, scopeFromSnapshot } from "@/lib/projects/product-scope";
import { readLatestCostEntries } from "@/lib/projects/latest-cost-adapter";
import { buildProcurementTargets, type TargetActual, type TargetRow, type TargetTotals } from "@/lib/projects/procurement-targets";
import type { CostEstimate } from "@/lib/projects/latest-cost";
import { resolveRoles } from "@/lib/approvals/role-store";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { getCostingReportAction } from "./profitability-actions";

export interface ProcurementResult {
  ok: boolean; error?: string;
  data?: { reference: string; rows: TargetRow[]; totals: TargetTotals; estimateCaptured: boolean; saleLinked: boolean; saleNumber: string | null; asOf: string; costRead: "OK" | "UNAVAILABLE"; scopeBlockers: string[]; notes: string[] };
}
const NO_CIN7: PhysicalPort = {
  async readSale() { throw new Error("no Cin7 Sale is linked"); },
  async readStock() { throw new Error("no Cin7 Sale is linked"); },
  async readAssemblies() { throw new Error("no Cin7 Sale is linked"); },
};

export async function getProcurementTargetsAction(projectId: string): Promise<ProcurementResult> {
  try {
    const { orgId, userId } = await requireModuleAccess(PROJECTS_MODULE.href);
    assertNewquipOrg(orgId);
    const db = createServiceRoleClient();
    let adminTier = false;
    try { await requireOrgAdmin("see procurement cost targets"); adminTier = true; } catch { adminTier = false; } // fail closed
    const roles = await resolveRoles(db, orgId, userId, adminTier);
    if (!(adminTier || roles.has("MANAGER") || roles.has("PROCUREMENT"))) throw new Error("The cost targets are for buyers and managers: ask an administrator for the Procurement role.");
    await guardBillingScope(db, orgId, projectId, adminTier);
    const p = await db.from("projects").select("project_reference, baseline_snapshot, billing_scope, parent_project_id").eq("org_id", orgId).eq("id", projectId).maybeSingle();
    if (p.error) throw new Error(p.error.message);
    const proj = p.data as { project_reference: string; baseline_snapshot?: { provenance?: { newquipQuoteId?: string } } | null; billing_scope?: string | null; parent_project_id?: string | null } | null;
    if (!proj) throw new Error("Project not found.");
    if (proj.billing_scope === "VARIATION" || proj.parent_project_id) throw new Error("Cost targets are shown on the original project.");
    const eff = effectiveScope(scopeFromSnapshot(proj.baseline_snapshot));
    const scope = eff.lines.map((l) => ({ sku: l.sku, description: l.description, quantity: l.quantity }));
    const notes: string[] = [];

    // The estimate frozen with the approved quotation (never recomputed, never altered by a later Cin7 cost).
    let estimate: CostEstimate | null = null;
    const quoteId = proj.baseline_snapshot?.provenance?.newquipQuoteId;
    if (quoteId) {
      const q = await db.from("newquip_quotes").select("accepted_baseline, project_id").eq("org_id", orgId).eq("id", quoteId).maybeSingle();
      const row = q.data as { accepted_baseline?: { physicalCostEstimate?: CostEstimate } | null; project_id?: string | null } | null;
      if (row && row.project_id === projectId) estimate = row.accepted_baseline?.physicalCostEstimate ?? null;
    }
    if (!estimate) notes.push("No cost estimate was captured before this quotation was approved, so there is no approved cost to compare against.");

    // Stock and order position (Cin7 GET), exactly as the Products & Fulfilment tab reads it.
    const link = await loadSaleLink(db, orgId, projectId).catch(() => null);
    const physical = await loadPhysicalStatus(db, link ? buildPhysicalPort(db, orgId, link.instance_id) : NO_CIN7, { orgId, projectId });

    // Today's Cin7 latest cost for the same SKUs (a fresh GET; never stored).
    let current: Awaited<ReturnType<typeof readLatestCostEntries>> | null = null;
    let costRead: "OK" | "UNAVAILABLE" = "OK";
    try { current = await readLatestCostEntries(db, orgId, link?.instance_id ?? NEWQUIP_POC_CIN7_INSTANCE_ID, scope.map((l) => l.sku), new Date().toISOString()); }
    catch { costRead = "UNAVAILABLE"; notes.push("Today's Cin7 costs could not be read just now."); }

    // Recognised actual cost: only for those who may see the project costing (owner/admin); everyone else sees none rather than a guess.
    let actual: Record<string, TargetActual> | null = null;
    if (adminTier) {
      const rep = await getCostingReportAction(projectId).catch(() => null);
      if (rep?.ok && rep.data) {
        actual = {};
        for (const r of rep.data.bySku) if (r.actualQuantity !== null && r.actualCents !== null && r.actualQuantity > 0) actual[r.sku] = { quantity: r.actualQuantity, costCents: r.actualCents };
      }
    }
    const built = buildProcurementTargets({
      estimate, scope, current,
      physical: physical.rows.map((r) => ({ sku: r.sku, ordered: r.ordered, onHand: r.onHand, available: r.available, shortfall: r.shortfall, remainingToDeliver: r.remainingToDeliver })), actual,
    });
    return { ok: true, data: { reference: proj.project_reference, rows: built.rows, totals: built.totals, estimateCaptured: built.estimateCaptured, saleLinked: physical.linked, saleNumber: physical.saleNumber, asOf: physical.asOf, costRead, scopeBlockers: physical.scopeBlockers, notes } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error" };
  }
}
