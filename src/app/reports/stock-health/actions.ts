"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import {
  getStockHealthReport,
  getProductAvailabilitySyncStatus,
  type StockHealthFilters,
  type StockHealthRow,
  type ProductAvailabilitySyncStatus,
} from "@/reports/query";
import { buildStockHealthSheet } from "@/reports/stock-health-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";
import { syncOrgProductAvailability, type ProductAvailabilitySyncSummary } from "@/sync/sync-product-availability";

export interface StockHealthActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export async function loadStockHealthReportAction(filters: StockHealthFilters): Promise<StockHealthActionResult<StockHealthRow[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getStockHealthReport(db, orgId, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadProductAvailabilitySyncStatusAction(): Promise<StockHealthActionResult<ProductAvailabilitySyncStatus>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductAvailabilitySyncStatus(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** On-demand stock-level sync for the current org's active instances — same direct-call pattern as triggerSalesSyncAction, already gated by the logged-in session. */
export async function triggerProductAvailabilitySyncAction(): Promise<StockHealthActionResult<ProductAvailabilitySyncSummary[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await syncOrgProductAvailability(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen into a real .xlsx file — same pattern as exportInventoryMovementXlsxAction. */
export async function exportStockHealthXlsxAction(rows: StockHealthRow[]): Promise<StockHealthActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildStockHealthSheet(rows);
    return { ok: true, data: await renderXlsxBase64(sheet, "Stock Health") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
