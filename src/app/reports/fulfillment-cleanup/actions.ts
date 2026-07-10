"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForCosting } from "@/cin7/product-cost";
import { getOrderFulfillmentReport, getOrderFulfillmentLines, getProductAvailabilitySyncStatus, type ProductAvailabilitySyncStatus } from "@/reports/query";
import type { NegativeAvailabilityRow, BackorderDemandRow, FulfillmentCleanupLine } from "@/reports/fulfillment-cleanup/build";
import { buildFulfillmentCleanupCsv } from "@/export/fulfillment-cleanup-csv";
import { buildIncludedSalesCsv } from "@/export/fulfillment-cleanup-included-sales-csv";
import { syncOrgProductAvailability, type ProductAvailabilitySyncSummary } from "@/sync/sync-product-availability";

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
  /** The customer's own PO/reference number, if given — often the clearest way to recognize which order to exclude. */
  customerReference: string | null;
  orderDate: string | null;
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
        customerReference: o.customer_reference,
        orderDate: o.order_date,
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

/** An audit-trail export (not a Cin7 import file): every backordered sale the user did NOT exclude from this cleanup run — a record of exactly which orders a given Bulk Stock Adjustment import was meant to unblock. */
export async function downloadIncludedSalesCsvAction(sales: BackorderedSale[]): Promise<FulfillmentCleanupActionResult<string>> {
  try {
    await requireCurrentOrg();
    return { ok: true, data: buildIncludedSalesCsv(sales) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Scoped to this one instance (unlike Stock Health's org-wide status) — the cleanup list only ever comes from one instance at a time, and an org-wide "last synced" could mask this specific instance being stale behind another that happened to sync more recently. */
export async function loadFulfillmentCleanupSyncStatusAction(instanceId: string): Promise<FulfillmentCleanupActionResult<ProductAvailabilitySyncStatus>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductAvailabilitySyncStatus(db, orgId, instanceId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** On-demand stock-level sync for just this one instance — same direct-call pattern as Stock Health's own trigger action, scoped down via syncOrgProductAvailability's instanceIds filter so it doesn't also re-sync every other instance on the org. */
export async function triggerFulfillmentCleanupSyncAction(instanceId: string): Promise<FulfillmentCleanupActionResult<ProductAvailabilitySyncSummary[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await syncOrgProductAvailability(db, orgId, [instanceId]) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
