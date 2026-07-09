import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductAvailability } from "@/cin7/product-availability";

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
 * "deleted" signal to react to. Deletes every row for this
 * (org_id, instance_id) BEFORE inserting the fresh snapshot — in that
 * order, so a mid-run failure can't leave duplicate stale+fresh rows (a
 * failure after delete but before insert just leaves this instance's data
 * empty until the next successful run, which is the safer failure mode).
 */
export async function syncInstanceProductAvailability(db: SupabaseClient, orgId: string, instanceId: string): Promise<ProductAvailabilitySyncSummary> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const entries = await fetchAllProductAvailability(creds);

  const { error: deleteError } = await db.from("product_availability").delete().eq("org_id", orgId).eq("instance_id", instanceId);
  if (deleteError) throw new Error(`product_availability delete: ${deleteError.message}`);

  if (entries.length) {
    const rows = entries.map((e) => ({
      org_id: orgId,
      instance_id: instanceId,
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
    const { error: insertError } = await db.from("product_availability").insert(rows);
    if (insertError) throw new Error(`product_availability insert: ${insertError.message}`);
  }

  return { instanceId, rowsSynced: entries.length };
}

/**
 * Syncs stock levels for active instances — every one for the org, or just
 * the given subset. Per-instance failures are caught so one bad instance
 * doesn't stop others (same as syncOrgAssemblyBuilds/syncOrgPurchases) —
 * critically, a failure here must NOT touch product_availability at all for
 * that instance (the delete+insert already happened or didn't; there's no
 * partial state to clean up), so a failed instance simply keeps its last
 * good snapshot until the next successful run.
 */
export async function syncOrgProductAvailability(db: SupabaseClient, orgId?: string, instanceIds?: string[]): Promise<ProductAvailabilitySyncSummary[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);

  const results: ProductAvailabilitySyncSummary[] = [];
  for (const instance of (instances ?? []) as { id: string; org_id: string }[]) {
    try {
      results.push(await syncInstanceProductAvailability(db, instance.org_id, instance.id));
    } catch (e) {
      results.push({ instanceId: instance.id, rowsSynced: 0, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }
  return results;
}
