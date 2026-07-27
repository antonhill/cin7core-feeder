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
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

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
