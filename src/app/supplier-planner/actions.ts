"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireWriteAllowed } from "@/lib/billing";
import { logActivity } from "@/lib/activity-log";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForSupplierPlanning } from "@/cin7/product-supplier-options";
import { createPurchaseOrder } from "@/cin7/purchase-write";
import { getReorderReport } from "@/reports/query";
import { buildSupplierPlanLines, groupLinesForPurchaseOrders, type SupplierPlanExtra, type SupplierPlanLine } from "@/reports/supplier-planner/build";
import { buildSupplierPlanSheet } from "@/reports/supplier-planner-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

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
    const extraBySku = new Map<string, SupplierPlanExtra>(
      reorderRows.map((r) => [r.product_sku, { onOrder: r.on_order, moverCategory: r.mover_category, status: r.status }])
    );

    const lines = buildSupplierPlanLines(
      products,
      velocityBySku,
      onHandBySku,
      { bufferPercent: params.bufferPercent, periodDays: params.periodDays },
      extraBySku
    );

    return { ok: true, data: lines };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen (post-filter) into a real .xlsx file — same pattern as exportReorderReportXlsxAction. */
export async function exportSupplierPlanXlsxAction(lines: SupplierPlanLine[]): Promise<SupplierPlanActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildSupplierPlanSheet(lines);
    return { ok: true, data: await renderXlsxBase64(sheet, "Supplier Planner") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface CreatedPurchaseOrder {
  supplierName: string;
  locationName: string;
  orderNumber: string;
  status: string;
  lineCount: number;
}

export interface FailedPurchaseOrder {
  supplierName: string;
  locationName: string;
  error: string;
}

export interface CreatePurchaseOrdersResult {
  created: CreatedPurchaseOrder[];
  failed: FailedPurchaseOrder[];
}

/**
 * Creates one real DRAFT Purchase Order per (supplier, location) group of
 * selected lines — see src/reports/supplier-planner/build.ts's
 * groupLinesForPurchaseOrders for why it's (supplier, location) and not
 * just supplier, and src/cin7/purchase-write.ts's createPurchaseOrder for
 * the confirmed two-step Cin7 write shape (7 rounds of live trial-and-error,
 * src/cin7/debug.ts's testCreatePurchaseOrder).
 *
 * Unlike createReplenishTransfersAction's single top-level try/catch (which
 * loses activity-log evidence of already-succeeded groups if a later one
 * fails), this catches per-group — a failure partway through still reports
 * and logs whichever POs genuinely got created in Cin7, rather than
 * silently discarding that they happened.
 */
export async function createSupplierPlanPurchaseOrdersAction(
  instanceId: string,
  lines: SupplierPlanLine[]
): Promise<SupplierPlanActionResult<CreatePurchaseOrdersResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!lines.length) return { ok: false, error: "Select at least one line to create a PO from." };

  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const groups = groupLinesForPurchaseOrders(lines);
    const created: CreatedPurchaseOrder[] = [];
    const failed: FailedPurchaseOrder[] = [];

    for (const group of groups) {
      try {
        const result = await createPurchaseOrder(creds, {
          supplierName: group.supplierName,
          supplierId: group.supplierId,
          locationName: group.locationName,
          locationId: group.locationId,
          lines: group.lines.map((l) => ({
            productId: l.productId,
            sku: l.productSku,
            name: l.productName,
            quantity: l.suggestedQty,
            price: l.cost ?? 0,
          })),
        });
        created.push({
          supplierName: group.supplierName,
          locationName: group.locationName,
          orderNumber: result.orderNumber,
          status: result.status,
          lineCount: result.lineCount,
        });
      } catch (e) {
        failed.push({
          supplierName: group.supplierName,
          locationName: group.locationName,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    if (created.length) {
      await logActivity(db, {
        orgId,
        instanceId,
        actor: { userId, email },
        action: "supplier_planner.create_purchase_order",
        summary: `Created ${created.length} draft PO${created.length === 1 ? "" : "s"} across ${new Set(created.map((c) => c.supplierName)).size} supplier${new Set(created.map((c) => c.supplierName)).size === 1 ? "" : "s"}${failed.length ? ` (${failed.length} failed)` : ""}`,
        detail: { created, failed },
      });
    }

    return {
      ok: failed.length === 0,
      data: { created, failed },
      error: failed.length ? `${failed.length} of ${groups.length} PO(s) failed to create` : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
