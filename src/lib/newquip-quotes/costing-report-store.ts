import "server-only";
// NewQuip layer of the costing report: joins the FROZEN estimate in the project's accepted quote baseline (margin sheet), the variations' frozen
// estimates, Cin7 invoice-line costs (GET only, through the injected port), the non-stock cost ledger and the product "last supplied by" field.
// Read-only. INTERNAL: the caller must have established the viewer is an org owner/admin.
import type { createServiceRoleClient } from "@/supabase/server";
import { fetchAllRows } from "@/supabase/fetch-all-rows";
import type { AcceptedBaseline } from "@/newquip/quote/baseline";
import { buildCostingReport, type ActualSkuCost, type CostingInput, type CostingReport } from "@/lib/projects/costing-report";
import { loadConsolidatedProject } from "@/lib/projects/variation-billing-store";
import { loadSaleLink } from "@/lib/projects/cin7-posting-store";
import { listCostEntries } from "@/lib/projects/project-costs-store";
import { totalCosts } from "@/lib/projects/project-costs";
import type { PhysicalPort } from "@/lib/projects/physical-store";

type Db = ReturnType<typeof createServiceRoleClient>;

export async function loadCostingReport(db: Db, portFor: (instanceId: string) => PhysicalPort, input: { orgId: string; projectId: string }): Promise<CostingReport | null> {
  const c = await loadConsolidatedProject(db, input.orgId, input.projectId);
  if (!c) return null;

  // frozen BASE estimate
  const q = await db.from("newquip_quotes").select("accepted_baseline").eq("org_id", input.orgId).eq("project_id", input.projectId).maybeSingle();
  const missing = q.error && /does not exist|schema cache/i.test(q.error.message);
  if (q.error && !missing) throw new Error(`load frozen estimate: ${q.error.message}`);
  const sheet = (q.data as { accepted_baseline: Pick<AcceptedBaseline, "internalMargin"> | null } | null)?.accepted_baseline?.internalMargin ?? null;

  // actual invoice-line cost by SKU over every scope's Sale (null if any scope's is unreadable)
  let actual: Record<string, ActualSkuCost> | null = {};
  for (const s of c.scopes) {
    const link = await loadSaleLink(db, input.orgId, s.projectId).catch(() => null);
    if (!link) continue; // no Sale yet: nothing has been invoiced on this scope
    let by: Record<string, ActualSkuCost> | null | undefined;
    try { by = (await portFor(link.instance_id).readSale(link.cin7_sale_id)).invoiceLineCostsBySku; } catch { by = null; }
    if (by === null || by === undefined) { actual = null; break; }
    for (const [sku, a] of Object.entries(by)) { const cur = actual[sku] ?? { quantity: 0, costCents: 0 }; actual[sku] = { quantity: cur.quantity + a.quantity, costCents: cur.costCents + a.costCents }; }
  }

  // non-stock ledger across scopes (null if unavailable)
  let nonStock: CostingInput["nonStock"] = { incurredCents: 0, committedCents: 0, byCategory: {} };
  for (const s of c.scopes) {
    const entries = await listCostEntries(db, input.orgId, s.projectId);
    if (entries === null) { nonStock = null; break; }
    const t = totalCosts(entries);
    nonStock.incurredCents += t.incurredCents; nonStock.committedCents += t.committedCents;
    for (const [cat, v] of Object.entries(t.byCategory)) { const cur = nonStock.byCategory[cat] ?? { incurredCents: 0, committedCents: 0 }; nonStock.byCategory[cat] = { incurredCents: cur.incurredCents + v.incurredCents, committedCents: cur.committedCents + v.committedCents }; }
  }

  // suppliers for the SKUs in play
  const wanted = new Set<string>([...Object.keys(actual ?? {}), ...(sheet?.lines ?? []).flatMap((l) => [l.sku, ...(l.components ?? []).map((x) => x.sku)]).filter((x): x is string => Boolean(x))]);
  const supplierBySku: Record<string, string | null> = {};
  if (wanted.size) {
    const rows = await fetchAllRows<{ sku: string; last_supplied_by: string | null }>("supplier groups", (from, to) =>
      db.from("products").select("sku, last_supplied_by").eq("org_id", input.orgId).in("sku", [...wanted]).order("sku").range(from, to));
    for (const r of rows) supplierBySku[r.sku] = r.last_supplied_by?.trim() || null;
  }

  const byVar = new Map(c.base.variations.map((v) => [v.code, v]));
  return buildCostingReport({
    base: sheet ? {
      contractCents: c.base.commercial.originalContractCents, estimatedCostCents: sheet.project.incomplete ? null : sheet.project.costCents, uncostedSellingCents: sheet.project.uncostedChargesCents,
      lines: sheet.lines.map((l) => ({ itemKey: l.itemKey, label: l.label, section: l.section, sku: l.sku ?? null, sellingCents: l.sellingCents, costCents: l.costCents, components: l.components?.map((x) => ({ sku: x.sku, description: x.description, sellingCents: x.sellingCents, costCents: x.costCents })) })),
      stages: c.base.stages.map((s) => ({ name: s.name, valueCents: s.valueCents })),
    } : null,
    variations: c.scopes.filter((s) => s.scope === "VARIATION").map((s) => ({ code: s.variationCode ?? "?", contractCents: s.contractCents, estimatedCostCents: byVar.get(s.variationCode ?? "")?.estimated_cost_cents ?? null })),
    actualBySku: actual, supplierBySku, nonStock,
    revisedContractCents: c.base.commercial.revisedContractCents,
  });
}
