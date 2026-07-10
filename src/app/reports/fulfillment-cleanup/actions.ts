"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForCosting } from "@/cin7/product-cost";
import { getOrderFulfillmentReport, getOrderFulfillmentLines } from "@/reports/query";
import type { NegativeAvailabilityRow, BackorderDemandRow, FulfillmentCleanupLine } from "@/reports/fulfillment-cleanup/build";
import { buildFulfillmentCleanupCsv } from "@/export/fulfillment-cleanup-csv";

export interface FulfillmentCleanupActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** One currently-backordered sale — shown as a checklist so a user can exclude the ones that should legitimately stay unfulfilled. */
export interface BackorderedSale {
  cin7SaleId: string;
  orderNumber: string | null;
  customerName: string | null;
  totalBackorderQty: number;
}

export interface FulfillmentCleanupPreviewData {
  negativeAvailabilityRows: NegativeAvailabilityRow[];
  /** A plain array, not a Map — server actions round-trip through JSON. The client rebuilds the Map. */
  averageCostEntries: { sku: string; averageCost: number }[];
  backorderDemand: BackorderDemandRow[];
  backorderedSales: BackorderedSale[];
  todayIso: string;
}

/**
 * Fetches every raw ingredient buildFulfillmentCleanupLines (in
 * @/reports/fulfillment-cleanup/build, a plain pure module with no
 * server-only imports) needs: every product_availability row with
 * available < 0 (the already-synced Stock Health snapshot — same source
 * as that report, so a stale sync here means a stale cleanup list too; the
 * page surfaces a "sync stock levels" link for that reason), a LIVE
 * per-instance average cost pull (fetchAllProductsForCosting, already used
 * by the Cost Estimator, rather than the hub's own canonical product
 * catalog — that catalog's average_cost is only as fresh as the last CSV
 * import/export), and every open sale's per-SKU backorder quantity (for
 * the per-sale exclusion feature). Deliberately does NOT build the final
 * lines itself — the client calls buildFulfillmentCleanupLines directly
 * with whichever sales are currently excluded, so toggling a checkbox
 * recomputes instantly with no extra round trip.
 */
export async function loadFulfillmentCleanupPreviewAction(instanceId: string): Promise<FulfillmentCleanupActionResult<FulfillmentCleanupPreviewData>> {
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
    const [products, orders, lines] = await Promise.all([
      fetchAllProductsForCosting(creds),
      getOrderFulfillmentReport(db, orgId, { instanceIds: [instanceId] }),
      getOrderFulfillmentLines(db, orgId, { instanceIds: [instanceId] }),
    ]);

    const averageCostEntries = products.filter((p) => p.averageCost !== null).map((p) => ({ sku: p.sku, averageCost: p.averageCost as number }));

    const backorderDemand: BackorderDemandRow[] = lines
      .filter((l) => l.backorder_qty > 0)
      .map((l) => ({ cin7SaleId: l.cin7_sale_id, productSku: l.product_sku, backorderQty: l.backorder_qty }));

    const backorderedSales: BackorderedSale[] = orders
      .filter((o) => o.total_backorder_qty > 0)
      .map((o) => ({
        cin7SaleId: o.cin7_sale_id,
        orderNumber: o.order_number,
        customerName: o.customer_name,
        totalBackorderQty: o.total_backorder_qty,
      }));

    const negativeAvailabilityRows: NegativeAvailabilityRow[] = (rows ?? []).map((r) => ({
      location: r.location,
      productSku: r.product_sku ?? "",
      productName: r.product_name,
      bin: r.bin,
      batchSn: r.batch_sn,
      expiryDate: r.expiry_date,
      onHand: r.on_hand ?? 0,
      available: r.available ?? 0,
    }));

    return {
      ok: true,
      data: {
        negativeAvailabilityRows,
        averageCostEntries,
        backorderDemand,
        backorderedSales,
        todayIso: new Date().toISOString().slice(0, 10),
      },
    };
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
