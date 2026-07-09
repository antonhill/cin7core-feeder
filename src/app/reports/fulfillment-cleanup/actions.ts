"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForCosting } from "@/cin7/product-cost";
import { buildFulfillmentCleanupLines, type FulfillmentCleanupLine } from "@/reports/fulfillment-cleanup/build";
import { buildFulfillmentCleanupCsv } from "@/export/fulfillment-cleanup-csv";

export interface FulfillmentCleanupActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface FulfillmentCleanupPreview {
  lines: FulfillmentCleanupLine[];
  /** SKUs that need a UnitCost (on_hand is 0) but have no average cost on file at all — these rows go out with a blank UnitCost, so they're flagged for the user to fill in by hand before importing. */
  missingCostSkus: string[];
}

/**
 * Builds the full set of Bulk Stock Adjustment lines for one instance: every
 * product_availability row with available < 0 (the already-synced Stock
 * Health snapshot — same source as that report, so a stale sync here means
 * a stale cleanup list too; the page surfaces a "sync stock levels" link
 * for that reason), cross-referenced against a LIVE per-instance average
 * cost pull (fetchAllProductsForCosting, already used by the Cost
 * Estimator) rather than the hub's own canonical product catalog, since
 * that catalog's average_cost is only as fresh as the last CSV
 * import/export and could be stale relative to what Cin7 itself would use
 * for a real adjustment.
 */
export async function loadFulfillmentCleanupPreviewAction(instanceId: string): Promise<FulfillmentCleanupActionResult<FulfillmentCleanupPreview>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    const { data: rows, error } = await db
      .from("product_availability")
      .select("location, product_sku, product_name, bin, batch_sn, expiry_date, on_hand, available")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .lt("available", 0)
      .order("product_sku")
      .order("location");
    if (error) throw new Error(error.message);

    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const products = await fetchAllProductsForCosting(creds);
    const averageCostBySku = new Map(products.filter((p) => p.averageCost !== null).map((p) => [p.sku, p.averageCost as number]));

    const todayIso = new Date().toISOString().slice(0, 10);
    const lines = buildFulfillmentCleanupLines(
      (rows ?? []).map((r) => ({
        location: r.location,
        productSku: r.product_sku ?? "",
        productName: r.product_name,
        bin: r.bin,
        batchSn: r.batch_sn,
        expiryDate: r.expiry_date,
        onHand: r.on_hand ?? 0,
        available: r.available ?? 0,
      })),
      averageCostBySku,
      todayIso
    );

    const missingCostSkus = [...new Set(lines.filter((l) => l.action === "Zero" && l.unitCost === null).map((l) => l.productSku))];

    return { ok: true, data: { lines, missingCostSkus } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen into the completed Bulk Stock Adjustment CSV — same "what you see is what you export" convention as every other report here. */
export async function downloadFulfillmentCleanupCsvAction(lines: FulfillmentCleanupLine[]): Promise<FulfillmentCleanupActionResult<string>> {
  try {
    await requireCurrentOrg();
    return { ok: true, data: buildFulfillmentCleanupCsv(lines) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
