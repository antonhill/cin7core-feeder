"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { getSalesFacts, getInventoryMovementFacts, type CustomReportFilters } from "@/reports/custom/facts";
import { aggregateCustomReport, type CustomReportResult, type DimensionDef } from "@/reports/custom/aggregate";
import { SALES_SOURCE, INVENTORY_MOVEMENT_SOURCE, type ReportSourceConfig, type ReportSourceKey } from "@/reports/custom/sources";
import { buildCustomReportSheet } from "@/reports/custom-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

export interface CustomReportActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface SavedCustomReport {
  id: string;
  name: string;
  source: ReportSourceKey;
  dimensions: string[];
  measures: string[];
  filters: CustomReportFilters;
}

interface CustomReportRow {
  id: string;
  name: string;
  source: string;
  dimensions: string[];
  measures: string[];
  filters: CustomReportFilters;
}

function toSavedReport(row: CustomReportRow): SavedCustomReport {
  return { id: row.id, name: row.name, source: row.source as ReportSourceKey, dimensions: row.dimensions, measures: row.measures, filters: row.filters };
}

function pickDimensions<Row>(source: ReportSourceConfig<Row>, keys: string[]): DimensionDef<Row>[] {
  return keys.map((k) => source.dimensions.find((d) => d.key === k)).filter((d): d is DimensionDef<Row> => Boolean(d));
}

/**
 * Fetches this source's facts, then aggregates server-side (small response,
 * same "aggregate before sending to the client" discipline as every other
 * report here). The FULL measure list for the source is passed to
 * aggregateCustomReport, not just the selected ones — a ratio measure like
 * Margin % needs its dependencies (Revenue/Profit) summed even if the client
 * didn't pick those as their own output columns.
 */
export async function runCustomReportAction(
  sourceKey: ReportSourceKey,
  dimensionKeys: string[],
  measureKeys: string[],
  filters: CustomReportFilters
): Promise<CustomReportActionResult<CustomReportResult>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    if (sourceKey === "sales") {
      const rows = await getSalesFacts(db, orgId, filters);
      return { ok: true, data: aggregateCustomReport(rows, pickDimensions(SALES_SOURCE, dimensionKeys), SALES_SOURCE.measures, measureKeys) };
    }
    if (sourceKey === "inventory_movement") {
      const rows = await getInventoryMovementFacts(db, orgId, filters);
      return {
        ok: true,
        data: aggregateCustomReport(rows, pickDimensions(INVENTORY_MOVEMENT_SOURCE, dimensionKeys), INVENTORY_MOVEMENT_SOURCE.measures, measureKeys),
      };
    }
    return { ok: false, error: "Unknown report source" };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders an already-computed result into a real .xlsx file — column labels resolved from the source's whitelist, same "shape data client-side, render server-side" split as exportReportXlsxAction. */
export async function exportCustomReportXlsxAction(
  sourceKey: ReportSourceKey,
  dimensionKeys: string[],
  measureKeys: string[],
  result: CustomReportResult
): Promise<CustomReportActionResult<string>> {
  try {
    await requireCurrentOrg();
    const source = sourceKey === "sales" ? SALES_SOURCE : INVENTORY_MOVEMENT_SOURCE;
    const dimensionLabels = dimensionKeys.map((k) => source.dimensions.find((d) => d.key === k)?.label ?? k);
    const measureLabels = measureKeys.map((k) => source.measures.find((m) => m.key === k)?.label ?? k);
    const sheet = buildCustomReportSheet(dimensionLabels, measureLabels, result);
    return { ok: true, data: await renderXlsxBase64(sheet, "Custom Report") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function listCustomReportsAction(): Promise<CustomReportActionResult<SavedCustomReport[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("custom_reports")
      .select("id, name, source, dimensions, measures, filters")
      .eq("org_id", orgId)
      .order("name");
    if (error) throw new Error(error.message);
    return { ok: true, data: ((data ?? []) as CustomReportRow[]).map(toSavedReport) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function saveCustomReportAction(
  name: string,
  sourceKey: ReportSourceKey,
  dimensionKeys: string[],
  measureKeys: string[],
  filters: CustomReportFilters
): Promise<CustomReportActionResult<SavedCustomReport>> {
  if (!name.trim()) return { ok: false, error: "Name is required." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("custom_reports")
      .insert({ org_id: orgId, name: name.trim(), source: sourceKey, dimensions: dimensionKeys, measures: measureKeys, filters })
      .select("id, name, source, dimensions, measures, filters")
      .single();
    if (error) throw new Error(error.message);
    return { ok: true, data: toSavedReport(data as CustomReportRow) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function deleteCustomReportAction(id: string): Promise<CustomReportActionResult<null>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const { error } = await db.from("custom_reports").delete().eq("id", id).eq("org_id", orgId);
    if (error) throw new Error(error.message);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
