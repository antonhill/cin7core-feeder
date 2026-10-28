import "server-only";
// Projects - consolidated PROFITABILITY (READ-ONLY). Reads the BASE project, its variation billing projects, their postings, and (through the
// injected port) the linked Cin7 Sales. Writes nothing anywhere. INTERNAL: the caller must have established that the viewer may see cost.
import type { createServiceRoleClient } from "@/supabase/server";
import { buildPhysicalStatus } from "./physical-status";
import { loadProjectView } from "./project-store";
import { loadConsolidatedProject } from "./variation-billing-store";
import { listPostings, loadSaleLink } from "./cin7-posting-store";
import type { PhysicalPort } from "./physical-store";
import { buildProfitability, type ProfitabilityReport, type ScopeInput } from "./profitability";

type Db = ReturnType<typeof createServiceRoleClient>;

/** Frozen cost knowledge the caller (NewQuip layer) supplies for the BASE scope; Projects itself knows nothing about quotes. */
export interface BaseCostInput { estimatedCostCents: number | null; uncostedSellingCents: number }

export async function loadProfitability(
  db: Db, portFor: (instanceId: string) => PhysicalPort, input: { orgId: string; projectId: string; base: BaseCostInput; now?: Date },
): Promise<ProfitabilityReport | null> {
  const c = await loadConsolidatedProject(db, input.orgId, input.projectId);
  if (!c) return null;
  const scopes: ScopeInput[] = [];
  for (const s of c.scopes) {
    const postings = await listPostings(db, input.orgId, s.projectId);
    const posted = postings.filter((p) => p.posting_state === "CREATED" || p.posting_state === "RECONCILED");
    const postedClaimIds = new Set(posted.map((p) => p.claim_id));
    // Approved (value-reserving) claims for this scope come from its own project view.
    const pv = await loadProjectView(db, input.orgId, s.projectId);
    const reserving = (pv?.claims ?? []).filter((cl) => cl.reserves);
    const unposted = reserving.filter((cl) => !postedClaimIds.has(cl.id)).reduce((n, cl) => n + cl.subtotal_cents, 0);

    const link = await loadSaleLink(db, input.orgId, s.projectId).catch(() => null);
    let cogsCents: number | null = null;
    let deliveryComplete: boolean | null = null;
    if (link) {
      try {
        const sale = await portFor(link.instance_id).readSale(link.cin7_sale_id);
        cogsCents = sale.cogsCents;
        const rows = buildPhysicalStatus({ ordered: sale.ordered, invoices: sale.invoices, fulfilments: sale.fulfilments, stock: {}, assemblies: [] }).rows;
        deliveryComplete = rows.length === 0 ? null : rows.every((r) => r.remaining !== null) ? rows.every((r) => (r.remaining as number) <= 0) : null;
      } catch { /* left unknown: surfaces as COGS_NOT_READ and keeps the actual margin withheld */ }
    }
    const variation = s.scope === "VARIATION" ? c.base.variations.find((v) => v.code === s.variationCode) : null;
    scopes.push({
      scope: s.scope, label: s.scope === "BASE" ? "Original contract" : `${s.variationCode} variation`, projectId: s.projectId,
      contractCents: s.contractCents, committedCents: s.committedCents,
      postedCents: posted.reduce((n, p) => n + p.amount_ex_vat_cents, 0), unpostedApprovedCents: unposted,
      mismatchedPostings: postings.filter((p) => p.last_error_code === "AMOUNT_MISMATCH").length,
      estimatedCostCents: s.scope === "BASE" ? input.base.estimatedCostCents : variation?.estimated_cost_cents ?? null,
      uncostedSellingCents: s.scope === "BASE" ? input.base.uncostedSellingCents : 0,
      saleNumber: link?.cin7_sale_number ?? null, cogsCents, deliveryComplete,
    });
  }
  return buildProfitability(scopes, (input.now ?? new Date()).toISOString());
}
