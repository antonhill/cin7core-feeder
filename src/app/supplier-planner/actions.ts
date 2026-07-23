"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForSupplierPlanning } from "@/cin7/product-supplier-options";
import { getReorderReport } from "@/reports/query";
import { buildSupplierPlanLines, type SupplierPlanLine } from "@/reports/supplier-planner/build";

export interface SupplierPlanActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface SupplierPlanParams {
  instanceId: string;
  velocityDateFrom: string;
  velocityDateTo: string;
  periodDays: number;
  bufferPercent: number;
}

/**
 * Combines a live Cin7 fetch (Suppliers[].ProductSupplierOptions — Lead/
 * Safety/ReorderQuantity/MinimumToReorder, src/cin7/product-supplier-
 * options.ts) with the same sales-velocity/on-hand data the Reorder Report
 * already computes (report_reorder RPC), scoped to this one instance so
 * the live supplier data and the DB-derived stock figures agree. This is
 * the Imports/lead-time-based workflow — see src/reports/supplier-planner/
 * build.ts's header comment for why it stays a separate tool from the
 * Reorder Report rather than merging with it.
 */
export async function loadSupplierPlanAction(params: SupplierPlanParams): Promise<SupplierPlanActionResult<SupplierPlanLine[]>> {
  if (!params.instanceId) return { ok: false, error: "Choose an instance." };

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    const creds = await loadCin7Credentials(db, orgId, params.instanceId);
    const [products, reorderRows] = await Promise.all([
      fetchAllProductsForSupplierPlanning(creds),
      getReorderReport(db, orgId, {
        instanceIds: [params.instanceId],
        velocityDateFrom: params.velocityDateFrom,
        velocityDateTo: params.velocityDateTo,
      }),
    ]);

    const velocityBySku = new Map(reorderRows.map((r) => [r.product_sku, r.total_out]));
    const onHandBySku = new Map(reorderRows.map((r) => [r.product_sku, r.on_hand]));

    const lines = buildSupplierPlanLines(products, velocityBySku, onHandBySku, {
      bufferPercent: params.bufferPercent,
      periodDays: params.periodDays,
    });

    return { ok: true, data: lines };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
