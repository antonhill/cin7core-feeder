"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import {
  getProductSalesReport,
  getProductSalesPivotData,
  getSaleLineDetails,
  getReportFilterOptions,
  getSalesSyncStatus,
  type SalesReportFilters,
  type ProductSalesReportRow,
  type SaleLineDetailRow,
  type ReportFilterOptions,
  type SalesSyncStatus,
} from "@/reports/query";
import type { PivotGroupBy, PivotSourceRow } from "@/reports/pivot";
import type { SheetExport } from "@/reports/export-xlsx";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";
import { syncOrgSales, type SalesSyncSummary } from "@/sync/sync-sales";

export interface ReportActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export async function loadReportFilterOptionsAction(): Promise<ReportActionResult<ReportFilterOptions>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getReportFilterOptions(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadProductSalesReportAction(filters: SalesReportFilters): Promise<ReportActionResult<ProductSalesReportRow[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductSalesReport(db, orgId, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadProductSalesPivotAction(
  filters: SalesReportFilters,
  groupBy: PivotGroupBy
): Promise<ReportActionResult<PivotSourceRow[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductSalesPivotData(db, orgId, filters, groupBy) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadSaleLineDetailsAction(
  filters: SalesReportFilters & { productSku?: string }
): Promise<ReportActionResult<SaleLineDetailRow[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getSaleLineDetails(db, orgId, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadSalesSyncStatusAction(): Promise<ReportActionResult<SalesSyncStatus>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getSalesSyncStatus(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Renders an already-built sheet (the client already has the report/pivot
 * data in state — see reports/export-xlsx.ts's pure builders) into a real
 * .xlsx file. Only the exceljs-specific rendering happens server-side; the
 * data shaping stays client-side and reusable, and requireCurrentOrg just
 * gates this to a logged-in org member like every other action here.
 */
export async function exportReportXlsxAction(sheet: SheetExport, sheetName: string): Promise<ReportActionResult<string>> {
  try {
    await requireCurrentOrg();
    return { ok: true, data: await renderXlsxBase64(sheet, sheetName) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** On-demand sales sync for the current org's active instances — same direct-call pattern as pushToCin7Action, not routed through the internal-auth HTTP endpoint since this is already gated by the logged-in session. */
export async function triggerSalesSyncAction(): Promise<ReportActionResult<SalesSyncSummary[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await syncOrgSales(db, orgId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
