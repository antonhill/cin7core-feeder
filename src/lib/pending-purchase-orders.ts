import "server-only";

import type { createServiceRoleClient } from "@/supabase/server";
import type { PendingPurchaseOrder, PendingPurchaseOrderLookup } from "@/reports/supplier-planner/build";

/**
 * Cross-references this app's own record of what it's created
 * (supplier_plan_created_po_lines, migration 0050) against the already-
 * synced `purchases.status` to find which lines still have a DRAFT (not
 * yet authorized) PO outstanding — see PendingPurchaseOrderLookup's own
 * comment in build.ts for the matching rule. A purchase whose status
 * hasn't synced yet (not found in `purchases` at all) is treated as still
 * pending — safer to over-flag a possible duplicate right after creation
 * than to under-flag one because the sync hasn't caught up.
 *
 * A plain server-side helper, deliberately NOT a Server Action: it takes an
 * already-constructed service-role `db` and an already-authorized `orgId`, so
 * it must only ever be called from an action that has itself run
 * requireModuleAccess/requireCurrentOrg first. It previously lived in
 * supplier-planner/actions.ts, where being exported from a "use server" file
 * made it a directly-invocable action endpoint with no guard of its own;
 * moving it here removes it from the action surface (Phase 1.2 hardening).
 */
export async function loadPendingPurchaseOrders(
  db: ReturnType<typeof createServiceRoleClient>,
  orgId: string,
  instanceId: string
): Promise<PendingPurchaseOrderLookup> {
  const { data: createdRows } = await db
    .from("supplier_plan_created_po_lines")
    .select("cin7_purchase_id, order_number, supplier_id, location_id, product_sku, created_at")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId);

  if (!createdRows?.length) return { byFullKey: new Map(), bySkuSupplier: new Map() };

  const purchaseIds = [...new Set(createdRows.map((r) => r.cin7_purchase_id))];
  const { data: purchaseRows } = await db
    .from("purchases")
    .select("cin7_purchase_id, status")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .in("cin7_purchase_id", purchaseIds);
  const statusByPurchaseId = new Map((purchaseRows ?? []).map((r) => [r.cin7_purchase_id, r.status as string | null]));

  const byFullKey = new Map<string, PendingPurchaseOrder>();
  const bySkuSupplier = new Map<string, PendingPurchaseOrder>();

  for (const row of createdRows) {
    const status = statusByPurchaseId.get(row.cin7_purchase_id);
    const isPending = !status || status === "DRAFT";
    if (!isPending) continue;

    const pending: PendingPurchaseOrder = { orderNumber: row.order_number ?? row.cin7_purchase_id, createdAt: row.created_at };
    const fullKey = `${row.product_sku}::${row.supplier_id}::${row.location_id}`;
    const skuSupplierKey = `${row.product_sku}::${row.supplier_id}`;

    const existingFull = byFullKey.get(fullKey);
    if (!existingFull || row.created_at > existingFull.createdAt) byFullKey.set(fullKey, pending);

    const existingSkuSupplier = bySkuSupplier.get(skuSupplierKey);
    if (!existingSkuSupplier || row.created_at > existingSkuSupplier.createdAt) bySkuSupplier.set(skuSupplierKey, pending);
  }

  return { byFullKey, bySkuSupplier };
}
