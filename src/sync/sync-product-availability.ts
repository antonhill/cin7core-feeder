import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductAvailability } from "@/cin7/product-availability";
import { acquireSyncRouteLock, releaseSyncRouteLock } from "@/lib/sync-route-lock";

export interface ProductAvailabilitySyncSummary {
  instanceId: string;
  rowsSynced: number;
  error?: string;
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * The first "wipe and reload" sync in this codebase — every other sync
 * (sales/purchases/assembly builds) is an append-only event log, upserting
 * by a stable Cin7 ID. Product Availability is a live snapshot: a
 * location/bin/batch row simply stops being returned once its stock hits
 * zero-with-no-allocation, so there's no ID to upsert against and no
 * "deleted" signal to react to.
 *
 * Security re-audit P0-7: the delete+insert used to be two separate
 * PostgREST requests — a failure between them left this instance's data
 * EMPTY, not "keeps the last good snapshot" as the old comment here
 * (wrongly) claimed. `replace_product_availability` (migration 0074) wraps
 * both in one Postgres function, so it's one transaction: a failure at any
 * point (including partway through the insert) rolls back the delete too,
 * genuinely preserving the previous snapshot — confirmed live 2026-08-17
 * against a real 3,844-row instance (a deliberately malformed row aborted
 * the call and the count came back unchanged, not empty).
 */
export async function syncInstanceProductAvailability(db: SupabaseClient, orgId: string, instanceId: string): Promise<ProductAvailabilitySyncSummary> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const entries = await fetchAllProductAvailability(creds);

  const rows = entries.map((e) => ({
    product_sku: e.SKU ?? null,
    product_name: e.Name ?? null,
    location: e.Location ?? null,
    bin: e.Bin ?? null,
    batch_sn: e.Batch ?? null,
    expiry_date: toDateOnly(e.ExpiryDate),
    on_hand: e.OnHand ?? null,
    available: e.Available ?? null,
    on_order: e.OnOrder ?? null,
    in_transit: e.InTransit ?? null,
    allocated: e.Allocated ?? null,
    stock_value: e.StockOnHand ?? null,
    next_delivery_date: toDateOnly(e.NextDeliveryDate),
    synced_at: new Date().toISOString(),
  }));

  const { error } = await db.rpc("replace_product_availability", { p_org_id: orgId, p_instance_id: instanceId, p_rows: rows });
  if (error) throw new Error(`replace_product_availability: ${error.message}`);

  return { instanceId, rowsSynced: entries.length };
}

/**
 * Syncs stock levels for active instances — every one for the org, or just
 * the given subset. Per-instance failures are caught so one bad instance
 * doesn't stop others (same as syncOrgAssemblyBuilds/syncOrgPurchases) — a
 * failed instance genuinely keeps its last good snapshot until the next
 * successful run, since replace_product_availability's single-transaction
 * atomicity means there's no partial state to clean up.
 *
 * Route lock (Phase 3.3a): reachable from this route's own cron tick,
 * on-demand POST, AND several report pages' direct "sync now" actions
 * (replenish/actions.ts, reports/stock-health/actions.ts, reports/
 * reorder-report/actions.ts, fulfillment-cleanup/actions.ts — the most
 * call sites of any sync route) — guarded per (org, "sync-product-
 * availability") for the same reasoning as syncOrgSales's own route lock.
 */
export async function syncOrgProductAvailability(db: SupabaseClient, orgId?: string, instanceIds?: string[]): Promise<ProductAvailabilitySyncSummary[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);
  const allInstances = (instances ?? []) as { id: string; org_id: string }[];

  const runInstances = async (list: typeof allInstances) => {
    const results: ProductAvailabilitySyncSummary[] = [];
    for (const instance of list) {
      try {
        results.push(await syncInstanceProductAvailability(db, instance.org_id, instance.id));
      } catch (e) {
        results.push({ instanceId: instance.id, rowsSynced: 0, error: e instanceof Error ? e.message : "Unknown error" });
      }
    }
    return results;
  };

  if (!orgId) return runInstances(allInstances);

  const routeLock = await acquireSyncRouteLock(db, "sync-product-availability", orgId);
  if (!routeLock.acquired) return [];
  try {
    return await runInstances(allInstances);
  } finally {
    await releaseSyncRouteLock(db, "sync-product-availability", orgId, routeLock.lockedAt);
  }
}
