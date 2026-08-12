"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { REPORTS_MODULE } from "@/app/module-nav";
import {
  getReorderReport,
  getProductAvailabilitySyncStatus,
  type ReorderReportFilters,
  type ReorderReportRow,
  type ProductAvailabilitySyncStatus,
} from "@/reports/query";
import { syncOrgProductAvailability, type ProductAvailabilitySyncSummary } from "@/sync/sync-product-availability";
import { buildReorderReportSheet } from "@/reports/reorder-report-export";
import { buildSupplierPlanSheet } from "@/reports/supplier-planner-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForSupplierPlanning } from "@/cin7/product-supplier-options";
import { fetchAllLocations, type Cin7Location } from "@/cin7/reference-lookups";
import { buildReorderReportSupplierLines } from "@/reports/reorder-report/build";
import type { SupplierPlanLine, PurchaseOrderFallbackLocation } from "@/reports/supplier-planner/build";
// CreatedPurchaseOrder/FailedPurchaseOrder are NOT re-exported from here —
// a bare `export type { X, Y };` re-export in a "use server" file has caused
// three separate production outages in this codebase (ReferenceError at
// module evaluation, since it doesn't get elided by Next's "use server"
// transform under Turbopack). Callers that need those types import them
// straight from supplier-planner/actions, their real source.
import { createSupplierPlanPurchaseOrdersAction, type CreatePurchaseOrdersResult } from "@/app/supplier-planner/actions";
import { loadPendingPurchaseOrders } from "@/lib/pending-purchase-orders";

export interface ReorderReportActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export async function loadReorderReportAction(filters: ReorderReportFilters): Promise<ReorderReportActionResult<ReorderReportRow[]>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    return { ok: true, data: await getReorderReport(db, orgId, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Same shared product_availability snapshot Stock Health syncs — reused here since this report reads the same table (on_hand/on_order/stock_value). */
export async function loadReorderReportSyncStatusAction(): Promise<ReorderReportActionResult<ProductAvailabilitySyncStatus>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductAvailabilitySyncStatus(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function triggerReorderReportSyncAction(): Promise<ReorderReportActionResult<ProductAvailabilitySyncSummary[]>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    return { ok: true, data: await syncOrgProductAvailability(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen (post-filter) into a real .xlsx file — same pattern as exportStockHealthXlsxAction. */
export async function exportReorderReportXlsxAction(rows: ReorderReportRow[]): Promise<ReorderReportActionResult<string>> {
  try {
    await requireModuleAccess(REPORTS_MODULE.href);
    const sheet = buildReorderReportSheet(rows);
    return { ok: true, data: await renderXlsxBase64(sheet, "Reorder Report") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface ReorderReportSupplierData {
  lines: SupplierPlanLine[];
  /** Every real location in the account, for the same "receiving location" picker Purchase Planner offers — every line here always needs one, since this report has no per-location supplier fetch at all. */
  locations: Cin7Location[];
}

/**
 * Live supplier fan-out for PO creation (2026-07-27, rebuilt after a
 * production incident — see cin7core-feeder-po-creation memory) — scoped to
 * exactly one instance, unlike the plain report above which can aggregate
 * several via instanceIds. A supplier fetch and a Purchase Order write are
 * inherently single-instance (Cin7 credentials/suppliers are per-instance).
 *
 * Re-queries report_reorder itself from small scalar filter params, exactly
 * like loadSupplierPlanAction does, rather than accepting the client's
 * already-loaded rows as an argument — a real catalog's full row set can run
 * to thousands of products, and passing that array through as a Server
 * Action argument risks exceeding Next's default request body limit. The
 * page narrows the result back down to whatever's currently visible
 * client-side.
 */
export async function loadReorderReportSupplierLinesAction(
  instanceId: string,
  filters: Omit<ReorderReportFilters, "instanceIds">
): Promise<ReorderReportActionResult<ReorderReportSupplierData>> {
  if (!instanceId) return { ok: false, error: "Choose exactly one instance to enable supplier data and PO creation." };

  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const [rows, products, locations, pendingPurchaseOrders] = await Promise.all([
      getReorderReport(db, orgId, { ...filters, instanceIds: [instanceId] }),
      fetchAllProductsForSupplierPlanning(creds),
      fetchAllLocations(creds),
      loadPendingPurchaseOrders(db, orgId, instanceId),
    ]);

    const lines = buildReorderReportSupplierLines(rows, products, pendingPurchaseOrders);
    return { ok: true, data: { lines, locations } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Delegates straight to Purchase Planner's own PO-creation action — see its
 * own comment for the confirmed write shape, per-group partial-failure
 * handling, and activity logging. There's nothing report-specific about
 * creating a PO once the lines are already in SupplierPlanLine's shape.
 */
export async function createReorderReportPurchaseOrdersAction(
  instanceId: string,
  lines: SupplierPlanLine[],
  fallbackLocation?: PurchaseOrderFallbackLocation
): Promise<ReorderReportActionResult<CreatePurchaseOrdersResult>> {
  return createSupplierPlanPurchaseOrdersAction(instanceId, lines, fallbackLocation);
}

/** Same export shape as Purchase Planner's own sheet (Supplier/Lead/Safety/Currency/Suggested Qty/…) — reused as-is since these lines are literally SupplierPlanLine. */
export async function exportReorderReportSupplierLinesXlsxAction(lines: SupplierPlanLine[]): Promise<ReorderReportActionResult<string>> {
  try {
    await requireModuleAccess(REPORTS_MODULE.href);
    const sheet = buildSupplierPlanSheet(lines);
    return { ok: true, data: await renderXlsxBase64(sheet, "Reorder Report Suppliers") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
