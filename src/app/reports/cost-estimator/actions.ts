"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForCosting } from "@/cin7/product-cost";
import {
  fetchLatestProductionOrdersBySku,
  fetchProductionOrderDetail,
} from "@/cin7/production-order-detail";
import {
  estimateAssemblyCost,
  type CostBasis,
  type AssemblyCostEstimate,
  type ComponentCostInfo,
} from "@/costing/estimate";
import {
  estimateProductionCost,
  type ProductionCostEstimate,
} from "@/costing/production-estimate";
import {
  buildCostEstimateSheet,
  buildCostEstimateSummarySheet,
} from "@/reports/cost-estimator-export";
import {
  buildProductionCostEstimateSheet,
  buildProductionCostEstimateSummarySheet,
} from "@/reports/production-cost-estimator-export";
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
    products.map((p) => [
      p.sku,
      { averageCost: p.averageCost, suppliers: p.suppliers },
    ]),
  );
  const assemblies = products.filter(
    (p) => p.isAssembly && p.bomLines.length > 0,
  );
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
  basis: CostBasis,
): Promise<CostEstimatorActionResult<AssemblyCostEstimate[]>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const { assemblies, costsBySku } = await fetchCostingData(
      orgId,
      instanceId,
    );
    const estimates = assemblies.map((a) =>
      estimateAssemblyCost(a.sku, a.name, a.bomLines, costsBySku, basis),
    );
    return { ok: true, data: estimates };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

/** Full per-assembly-per-component detail, with a TOTAL subtotal row per assembly. */
export async function exportCostEstimatesAction(
  estimates: AssemblyCostEstimate[],
): Promise<CostEstimatorActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildCostEstimateSheet(estimates);
    return { ok: true, data: await renderXlsxBase64(sheet, "Cost Estimate") };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

/** One row per finished good — just its total production cost, no component breakdown. */
export async function exportCostEstimatesSummaryAction(
  estimates: AssemblyCostEstimate[],
): Promise<CostEstimatorActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildCostEstimateSummarySheet(estimates);
    return {
      ok: true,
      data: await renderXlsxBase64(sheet, "Cost Estimate Summary"),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

export interface ProductionCostEstimatorResult {
  estimates: ProductionCostEstimate[];
  totalProductionSkus: number;
  skippedNoOrder: number;
}

/**
 * Every Production BOM SKU on this instance that has at least one completed
 * Manufacture Order, re-priced under the chosen cost basis. Unlike Assembly
 * BOMs, a Production BOM's recipe can only be read from a completed order —
 * confirmed 2026-07-08 that /production/productionBOM (the BOM
 * *definition*) returns zero versions even for a SKU proven to have a real,
 * built BOM version. A Production BOM that's never been run has no
 * live-readable recipe and is silently excluded from `estimates`, but
 * counted in `skippedNoOrder` so the UI can say so rather than the count
 * just not adding up with no explanation.
 */
export async function getProductionCostEstimatesAction(
  instanceId: string,
  basis: CostBasis,
): Promise<CostEstimatorActionResult<ProductionCostEstimatorResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const products = await fetchAllProductsForCosting(creds);
    const costsBySku = new Map<string, ComponentCostInfo>(
      products.map((p) => [
        p.sku,
        { averageCost: p.averageCost, suppliers: p.suppliers },
      ]),
    );
    const productionProducts = products.filter(
      (p) => p.bomType === "Production",
    );
    const latestOrders = await fetchLatestProductionOrdersBySku(creds);

    const estimates: ProductionCostEstimate[] = [];
    let skippedNoOrder = 0;
    for (const p of productionProducts) {
      const orderInfo = latestOrders.get(p.sku);
      if (!orderInfo) {
        skippedNoOrder++;
        continue;
      }
      const detail = await fetchProductionOrderDetail(
        creds,
        orderInfo.productionOrderId,
      );
      estimates.push(
        estimateProductionCost(
          p.sku,
          p.name,
          orderInfo.orderNumber,
          orderInfo.completionDate,
          detail.components,
          detail.resources,
          costsBySku,
          basis,
        ),
      );
    }

    return {
      ok: true,
      data: {
        estimates,
        totalProductionSkus: productionProducts.length,
        skippedNoOrder,
      },
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

/** Full per-product-per-line detail (Components + Resources), with a TOTAL row per product. */
export async function exportProductionCostEstimatesAction(
  estimates: ProductionCostEstimate[],
): Promise<CostEstimatorActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildProductionCostEstimateSheet(estimates);
    return {
      ok: true,
      data: await renderXlsxBase64(sheet, "Production Cost Estimate"),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}

/** One row per Production BOM product — just the totals, no line detail. */
export async function exportProductionCostEstimatesSummaryAction(
  estimates: ProductionCostEstimate[],
): Promise<CostEstimatorActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildProductionCostEstimateSummarySheet(estimates);
    return {
      ok: true,
      data: await renderXlsxBase64(sheet, "Production Cost Estimate Summary"),
    };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : "Unknown error",
    };
  }
}
