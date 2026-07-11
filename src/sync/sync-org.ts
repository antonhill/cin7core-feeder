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

// Instances used to sync one at a time here, which meant two genuinely
// independent Cin7 accounts' own 60/min budgets (see the per-account keying
// in src/cin7/http.ts) were needlessly serialized — an org's 2 instances
// took roughly 2x as long as either alone. Bounded (not unbounded) since
// /api/sync's cron GET handler calls this with no orgId at all — it syncs
// every active instance across every organization in one call — so
// unbounded concurrency here would mean every org's Cin7 traffic firing
// simultaneously in one Vercel invocation. 5 is a defensive cap for future
// growth: only 5 active instances exist across all orgs today (checked
// 2026-07-11), so this is effectively unbounded right now and only starts
// limiting anything once the tenant base grows well past this.
const MAX_CONCURRENT_INSTANCE_SYNCS = 5;

/** Runs `fn` over `items` with at most `limit` in flight at once, preserving each result's position in the returned array regardless of completion order. */
async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await fn(items[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
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

  return mapWithConcurrency(instances ?? [], MAX_CONCURRENT_INSTANCE_SYNCS, async (instance): Promise<InstanceSyncOutcome> => {
    try {
      const summary = await syncInstance(db, instance.org_id, instance.id, scope);
      await logActivity(db, {
        orgId: instance.org_id,
        instanceId: instance.id,
        actor,
        action: "sync.push",
        summary: summarizeSyncOutcome(summary),
        detail: { ...summary },
      });
      return { ok: true, orgId: instance.org_id, ...summary };
    } catch (e) {
      const errorMessage = e instanceof Error ? e.message : "Unknown error";
      await logActivity(db, {
        orgId: instance.org_id,
        instanceId: instance.id,
        actor,
        action: "sync.push_failed",
        summary: `Sync failed: ${errorMessage}`,
      });
      return { ok: false, instanceId: instance.id, orgId: instance.org_id, error: errorMessage };
    }
  });
}
