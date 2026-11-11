"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { REPORTS_MODULE } from "@/app/module-nav";
import { getPoQuantityReport, type PoQuantityFilters, type PoQuantityReport } from "@/reports/po-quantity-query";
import { buildPoQuantitySheet } from "@/reports/po-quantity-export";
import type { PoQuantityRow } from "@/reports/po-quantity-comparison";
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

/** Renders the rows currently on screen (post filter/sort) — what you see is what you export. */
export async function exportPoQuantityXlsxAction(rows: PoQuantityRow[]): Promise<PoQuantityActionResult<string>> {
  try {
    await requireModuleAccess(REPORTS_MODULE.href);
    return { ok: true, data: await renderXlsxBase64(buildPoQuantitySheet(rows), "PO Quantity Comparison") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
