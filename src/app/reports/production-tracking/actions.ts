"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import {
  getProductionTrackingRows,
  getProductionOrderOperations,
  getProductionTrackingSyncStatus,
  type ProductionTrackingRow,
  type ProductionOperationRow,
  type ProductionTrackingSyncStatus,
} from "@/reports/production-tracking/query";
import { syncOrgProductionRuns, type ProductionRunsSyncSummary } from "@/sync/sync-production-runs";

export interface ProductionTrackingActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export async function loadProductionTrackingAction(
  instanceId: string,
  includeCompleted = false
): Promise<ProductionTrackingActionResult<ProductionTrackingRow[]>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductionTrackingRows(db, orgId, instanceId, includeCompleted) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export async function loadProductionOrderDetailAction(
  instanceId: string,
  productionOrderId: string
): Promise<ProductionTrackingActionResult<ProductionOperationRow[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductionOrderOperations(db, orgId, instanceId, productionOrderId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Scoped to this one instance — same convention as Replenish's own sync-status action. */
export async function loadProductionTrackingSyncStatusAction(instanceId: string): Promise<ProductionTrackingActionResult<ProductionTrackingSyncStatus>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductionTrackingSyncStatus(db, orgId, instanceId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * On-demand production-run sync for just this one instance — same
 * direct-call pattern as Replenish's/Fulfillment Cleanup's own trigger
 * action. force = true: a user clicking "Sync now" expects it to actually
 * fetch fresh data, so this bypasses Phase 2's 15-minute freshness gate
 * (which exists only to throttle the automated cron sweep).
 *
 * includeFinished re-fetches already-COMPLETED/VOIDED orders too — the
 * page passes this through only when its "Include completed/voided"
 * toggle is on, so a normal "Sync now" click still leaves finished orders'
 * (frozen-on-purpose) data alone.
 */
export async function triggerProductionTrackingSyncAction(
  instanceId: string,
  includeFinished = false
): Promise<ProductionTrackingActionResult<ProductionRunsSyncSummary[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await syncOrgProductionRuns(db, orgId, [instanceId], true, includeFinished) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
