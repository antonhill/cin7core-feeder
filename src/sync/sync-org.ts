import type { SupabaseClient } from "@supabase/supabase-js";
import { syncInstance, type PushScope } from "@/sync/run-sync";

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
  errors?: { sku: string; error: string }[];
}

/**
 * Syncs active Cin7 instances — every one for the org, or just the given
 * subset (`instanceIds`) when the caller wants to push to specific
 * instances only. Shared by /api/sync (cron + on-demand) and the Import
 * page's "push to Cin7" action so there's one sync-orchestration path.
 * Per-instance failures are caught so one bad instance doesn't stop others.
 */
export async function syncOrgInstances(
  db: SupabaseClient,
  orgId?: string,
  instanceIds?: string[],
  scope: PushScope = {}
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
    } catch (e) {
      results.push({
        ok: false,
        instanceId: instance.id,
        orgId: instance.org_id,
        error: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
  return results;
}
