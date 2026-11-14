"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { REPORTS_MODULE } from "@/app/module-nav";
import { getPoQuantityReport, type PoQuantityFilters, type PoQuantityReport } from "@/reports/po-quantity-query";
import { buildPoQuantitySheet } from "@/reports/po-quantity-export";
import { applyPoView, type PoViewSpec } from "@/reports/po-quantity-view";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

// "use server" file: async function exports ONLY (see CLAUDE.md) — types are erased and safe.
export interface PoQuantityActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/** Read-only: org comes from the session (never the client), and the query is additionally scoped to that org's own instances. */
export async function loadPoQuantityReportAction(filters: PoQuantityFilters): Promise<PoQuantityActionResult<PoQuantityReport>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    return { ok: true, data: await getPoQuantityReport(db, orgId, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Exports exactly what the table shows. The browser sends only the instance/date filters and the view spec
 * (filters + sort); the server reloads the report under the caller's own org and applies the same view — so the
 * request stays tiny regardless of row count (posting the rows themselves exceeded the platform body limit at
 * ~7k rows) and the data can never come from the client.
 */
export async function exportPoQuantityXlsxAction(input: { filters: PoQuantityFilters; view: PoViewSpec }): Promise<PoQuantityActionResult<string>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const report = await getPoQuantityReport(db, orgId, input.filters);
    const rows = applyPoView(report.rows, input.view);
    return { ok: true, data: await renderXlsxBase64(buildPoQuantitySheet(rows), "PO Quantity Comparison") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
