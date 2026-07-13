"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCasaDasNatasOrg } from "@/lib/require-casa-das-natas-org";
import { getNatasReport, getNatasFilterOptions, type NatasReportFilters, type NatasFilterOptions } from "@/reports/natas-query";
import type { NatasReportResult } from "@/reports/natas-report";

export interface NatasActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export async function loadNatasFilterOptionsAction(): Promise<NatasActionResult<NatasFilterOptions>> {
  try {
    await requireCasaDasNatasOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getNatasFilterOptions(db) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadNatasReportAction(filters: NatasReportFilters): Promise<NatasActionResult<NatasReportResult>> {
  try {
    await requireCasaDasNatasOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getNatasReport(db, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
