"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { REPORTS_MODULE } from "@/app/module-nav";
import { requireCasaDasNatasOrg } from "@/lib/require-casa-das-natas-org";
import { getNatasReport, getNatasFilterOptions, type NatasReportFilters, type NatasFilterOptions } from "@/reports/natas-query";
import type { NatasReportResult } from "@/reports/natas-report";

export interface NatasActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

/**
 * Both actions below establish TWO independent conditions before reading any
 * report data, in this order:
 *
 *   1. `requireModuleAccess(REPORTS_MODULE.href)` — the Reporting module
 *      gate every other report action applies. Placed first so this file
 *      reads like its siblings, with the extra restriction layered on top
 *      rather than replacing it.
 *   2. `requireCasaDasNatasOrg()` — the single-organization restriction that
 *      is specific to this report.
 *
 * The module check is NOT redundant with middleware or with this route's own
 * layout.tsx. A Server Action is a request whose path is the *referring
 * page*, not the action's own route, so middleware's path-based module block
 * never fires for the action itself — see CCT-ADR-0010 and
 * src/lib/authorization.ts. Before this guard was added, a Casa das Natas
 * member whose org (or per-member allow-list) had Reporting switched off
 * could still be served this report's data by invoking these actions from
 * another page. layout.tsx's redirect remains useful navigation protection
 * and is deliberately left unchanged; it is not the authorization boundary.
 *
 * Read-only: no billing/write-plan gate, no assurance step-up and no admin
 * role, matching every other report read in this module.
 */
export async function loadNatasFilterOptionsAction(): Promise<NatasActionResult<NatasFilterOptions>> {
  try {
    await requireModuleAccess(REPORTS_MODULE.href);
    await requireCasaDasNatasOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getNatasFilterOptions(db) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadNatasReportAction(filters: NatasReportFilters): Promise<NatasActionResult<NatasReportResult>> {
  try {
    await requireModuleAccess(REPORTS_MODULE.href);
    await requireCasaDasNatasOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getNatasReport(db, filters) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
