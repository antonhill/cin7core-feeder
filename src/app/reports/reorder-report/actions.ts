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
