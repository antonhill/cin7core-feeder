"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
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
import {
  loadPendingPurchaseOrders,
  createSupplierPlanPurchaseOrdersAction,
  type CreatePurchaseOrdersResult,
  type CreatedPurchaseOrder,
  type FailedPurchaseOrder,
} from "@/app/supplier-planner/actions";

export type { CreatedPurchaseOrder, FailedPurchaseOrder };

export interface ReorderReportActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export async function loadReorderReportAction(filters: ReorderReportFilters): Promise<ReorderReportActionResult<ReorderReportRow[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getReorderReport(db, orgId, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Same shared product_availability snapshot Stock Health syncs — reused here since this report reads the same table (on_hand/on_order/stock_value). */
export async function loadReorderReportSyncStatusAction(): Promise<ReorderReportActionResult<ProductAvailabilitySyncStatus>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductAvailabilitySyncStatus(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function triggerReorderReportSyncAction(): Promise<ReorderReportActionResult<ProductAvailabilitySyncSummary[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await syncOrgProductAvailability(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen (post-filter) into a real .xlsx file — same pattern as exportStockHealthXlsxAction. */
export async function exportReorderReportXlsxAction(rows: ReorderReportRow[]): Promise<ReorderReportActionResult<string>> {
  try {
    await requireCurrentOrg();
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
 * Live supplier fan-out for PO creation (2026-07-27) — scoped to exactly
 * one instance, unlike the plain report above which can aggregate several
 * via instanceIds. A supplier fetch and a Purchase Order write are
 * inherently single-instance (Cin7 credentials/suppliers are per-instance),
 * so the caller must have exactly one instance selected. Reuses the
 * already-loaded reorder rows rather than re-querying report_reorder — see
 * src/reports/reorder-report/build.ts for how the two are combined.
 */
export async function loadReorderReportSupplierLinesAction(
  instanceId: string,
  rows: ReorderReportRow[]
): Promise<ReorderReportActionResult<ReorderReportSupplierData>> {
  if (!instanceId) return { ok: false, error: "Choose exactly one instance to enable supplier data and PO creation." };

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const [products, locations, pendingPurchaseOrders] = await Promise.all([
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
    await requireCurrentOrg();
    const sheet = buildSupplierPlanSheet(lines);
    return { ok: true, data: await renderXlsxBase64(sheet, "Reorder Report Suppliers") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
