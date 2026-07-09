"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { getInventoryMovementReport, type InventoryMovementFilters, type InventoryMovementRow } from "@/reports/query";
import { buildInventoryMovementSheet } from "@/reports/inventory-movement-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

export interface InventoryMovementActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export async function loadInventoryMovementReportAction(
  filters: InventoryMovementFilters
): Promise<InventoryMovementActionResult<InventoryMovementRow[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getInventoryMovementReport(db, orgId, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen (the client already has the report rows) into a real .xlsx file — same pattern as exportReportXlsxAction. */
export async function exportInventoryMovementXlsxAction(rows: InventoryMovementRow[]): Promise<InventoryMovementActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildInventoryMovementSheet(rows);
    return { ok: true, data: await renderXlsxBase64(sheet, "Inventory Movement") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
