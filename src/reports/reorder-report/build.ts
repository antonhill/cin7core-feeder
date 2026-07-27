/**
 * Reorder Report's own supplier fan-out for PO creation (2026-07-27).
 *
 * Deliberately reuses `SupplierPlanLine` as the wire format — not because
 * this report has a lead time/import-floor concept (it doesn't), but purely
 * to reuse Purchase Planner's already-shipped, already-tested
 * `groupLinesForPurchaseOrders`/`createSupplierPlanPurchaseOrdersAction`/
 * `groupLinesBySupplier` unchanged (see src/app/reports/reorder-report/
 * actions.ts). `lead`/`safety`/`isImportSupplier`/`isUnconfigured` are
 * always neutral (0/false) here — nothing in this report or in the PO-
 * creation path actually reads them for anything other than display, and
 * Reorder Report's own threshold never depended on Lead/Safety in the first
 * place (see report_reorder's header comment). `locationId`/`locationName`
 * are always null — this report has no per-location supplier fetch, so
 * every group falls through to the caller-supplied receiving location.
 *
 * `threshold`/`onHand`/`onOrder` are exactly the same instance-wide
 * `reorder_threshold`/`on_hand`/`on_order` figures the plain report table
 * already shows (not a lead-time figure) — one row per (SKU, supplier),
 * not per (SKU, supplier, location). `suggestedQty` is a NEW figure, floored
 * at the supplier's own MOQ (`MinimumToReorder`) and netting off on_order,
 * exactly like Purchase Planner's own fix (src/reports/supplier-planner/
 * build.ts, 2026-07-27).
 */

import type { SupplierPlanLine, SupplierPlanProductInput, PendingPurchaseOrderLookup } from "@/reports/supplier-planner/build";
import type { ReorderReportRow } from "@/reports/query";

export function buildReorderReportSupplierLines(
  rows: ReorderReportRow[],
  products: SupplierPlanProductInput[],
  pendingPurchaseOrders: PendingPurchaseOrderLookup
): SupplierPlanLine[] {
  const rowBySku = new Map(rows.map((r) => [r.product_sku, r]));
  const lines: SupplierPlanLine[] = [];

  for (const product of products) {
    const row = rowBySku.get(product.sku);
    if (!row) continue; // nothing synced/no movement for this SKU in the report's own range — no reorder data to attach a supplier to

    for (const supplier of product.suppliers) {
      const defaultOption = supplier.options.find((o) => o.locationId === null) ?? supplier.options[0] ?? null;
      const moq = defaultOption?.minimumToReorder ?? 0;
      const suggestedQty = Math.max(moq, row.reorder_threshold - row.on_hand - row.on_order);

      const pendingPurchaseOrder = pendingPurchaseOrders.bySkuSupplier.get(`${product.sku}::${supplier.supplierId}`) ?? null;

      lines.push({
        productId: product.productId,
        productSku: product.sku,
        productName: product.name,
        category: product.category,
        brand: product.brand,
        supplierId: supplier.supplierId,
        supplierName: supplier.supplierName,
        currency: supplier.currency,
        cost: supplier.cost,
        locationId: null,
        locationName: null,
        lead: 0,
        safety: 0,
        onHand: row.on_hand,
        onOrder: row.on_order,
        totalOut: row.total_out,
        threshold: row.reorder_threshold,
        suggestedQty: Math.round(Math.max(suggestedQty, 0) * 100) / 100,
        needsReorder: row.needs_reorder,
        moverCategory: row.mover_category,
        status: row.status,
        isUnconfigured: false,
        pendingPurchaseOrder,
        isImportSupplier: false,
      });
    }
  }

  return lines;
}
