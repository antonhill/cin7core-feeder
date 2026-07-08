"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForCosting } from "@/cin7/product-cost";
import { estimateAssemblyCost, type CostBasis, type AssemblyCostEstimate, type ComponentCostInfo } from "@/costing/estimate";
import { buildCostEstimateSheet, buildCostEstimateSummarySheet } from "@/reports/cost-estimator-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

export interface CostEstimatorActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** One product's cost fields, keyed by SKU, for resolving BOM component costs against — see product-cost.ts's fetchAllProductsForCosting, the single live call this reads from. */
async function fetchCostingData(orgId: string, instanceId: string) {
  const db = createServiceRoleClient();
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const products = await fetchAllProductsForCosting(creds);
  const costsBySku = new Map<string, ComponentCostInfo>(
    products.map((p) => [p.sku, { averageCost: p.averageCost, suppliers: p.suppliers }])
  );
  const assemblies = products.filter((p) => p.isAssembly && p.bomLines.length > 0);
  return { assemblies, costsBySku };
}

/**
 * Every Assembly Build's BOM on this instance, re-priced under the chosen
 * cost basis — read-only, nothing written. Re-fetches live data on every
 * call rather than caching server-side: this is a diagnostic-style tool,
 * not a hot path, and re-fetching keeps every call independently correct
 * (no risk of the client holding a stale cost snapshot across a basis
 * toggle) at the cost of one extra full-catalog page-through per switch.
 */
export async function getCostEstimatesAction(
  instanceId: string,
  basis: CostBasis
): Promise<CostEstimatorActionResult<AssemblyCostEstimate[]>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const { assemblies, costsBySku } = await fetchCostingData(orgId, instanceId);
    const estimates = assemblies.map((a) => estimateAssemblyCost(a.sku, a.name, a.bomLines, costsBySku, basis));
    return { ok: true, data: estimates };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Full per-assembly-per-component detail, with a TOTAL subtotal row per assembly. */
export async function exportCostEstimatesAction(estimates: AssemblyCostEstimate[]): Promise<CostEstimatorActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildCostEstimateSheet(estimates);
    return { ok: true, data: await renderXlsxBase64(sheet, "Cost Estimate") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** One row per finished good — just its total production cost, no component breakdown. */
export async function exportCostEstimatesSummaryAction(estimates: AssemblyCostEstimate[]): Promise<CostEstimatorActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildCostEstimateSummarySheet(estimates);
    return { ok: true, data: await renderXlsxBase64(sheet, "Cost Estimate Summary") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
