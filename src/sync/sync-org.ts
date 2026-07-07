import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstance, type PushScope, type SyncRunSummary } from "@/sync/run-sync";
import { logActivity, type ActivityActor } from "@/lib/activity-log";

export interface InstanceSyncOutcome {
  ok: boolean;
  instanceId: string;
  orgId: string;
  error?: string;
  instanceName?: string;
  productsCreated?: number;
  productsUpdated?: number;
  productsSkipped?: number;
  productsFailed?: number;
  productionBomsPushed?: number;
  productionBomsFailed?: number;
  customersCreated?: number;
  customersUpdated?: number;
  customersSkipped?: number;
  customersFailed?: number;
  suppliersCreated?: number;
  suppliersUpdated?: number;
  suppliersSkipped?: number;
  suppliersFailed?: number;
  errors?: { sku: string; error: string[]; raw?: string }[];
}

/** "Pushed 3 products, 1 customer (2 failed)" / "No changes needed" — the activity-log summary for one instance's sync outcome. */
function summarizeSyncOutcome(summary: SyncRunSummary): string {
  const parts: string[] = [];
  const products = summary.productsCreated + summary.productsUpdated;
  if (products > 0) parts.push(`${products} product${products === 1 ? "" : "s"}`);
  const customers = summary.customersCreated + summary.customersUpdated;
  if (customers > 0) parts.push(`${customers} customer${customers === 1 ? "" : "s"}`);
  const suppliers = summary.suppliersCreated + summary.suppliersUpdated;
  if (suppliers > 0) parts.push(`${suppliers} supplier${suppliers === 1 ? "" : "s"}`);
  if (summary.productionBomsPushed > 0) parts.push(`${summary.productionBomsPushed} production BOM${summary.productionBomsPushed === 1 ? "" : "s"}`);

  const failed = summary.productsFailed + summary.customersFailed + summary.suppliersFailed + summary.productionBomsFailed;
  const base = parts.length > 0 ? `Pushed ${parts.join(", ")}` : "No changes needed";
  return failed > 0 ? `${base} (${failed} failed)` : base;
}

/**
 * Syncs active Cin7 instances — every one for the org, or just the given
 * subset (`instanceIds`) when the caller wants to push to specific
 * instances only. Shared by /api/sync (cron + on-demand) and the Import
 * page's "push to Cin7" action so there's one sync-orchestration path.
 * Per-instance failures are caught so one bad instance doesn't stop others.
 *
 * `actor` defaults to "system" — correct for both /api/sync call sites
 * (cron, and the bearer-token-authed on-demand POST), neither of which has
 * a real session user. pushToCin7Action passes the actual signed-in user.
 */
export async function syncOrgInstances(
  db: SupabaseClient,
  orgId?: string,
  instanceIds?: string[],
  scope: PushScope = {},
  actor: ActivityActor = "system"
): Promise<InstanceSyncOutcome[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);

  const results: InstanceSyncOutcome[] = [];
  for (const instance of instances ?? []) {
    try {
      const summary = await syncInstance(db, instance.org_id, instance.id, scope);
      results.push({ ok: true, orgId: instance.org_id, ...summary });
      await logActivity(db, {
        orgId: instance.org_id,
        instanceId: instance.id,
        actor,
        action: "sync.push",
        summary: summarizeSyncOutcome(summary),
        detail: { ...summary },
      });
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      results.push({ ok: false, instanceId: instance.id, orgId: instance.org_id, error: errorMessage });
      await logActivity(db, {
        orgId: instance.org_id,
        instanceId: instance.id,
        actor,
        action: "sync.push_failed",
        summary: `Sync failed: ${errorMessage}`,
      });
    }
  }
  return results;
}
