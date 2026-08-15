import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllPurchasesList } from "@/cin7/purchases";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";
import type { Cin7Credentials } from "@/cin7/types";
import { acquireSyncRouteLock, releaseSyncRouteLock } from "@/lib/sync-route-lock";

// Rate-limited detail fetch is one (sometimes two, on the Advanced-purchase
// fallback) Cin7 call per purchase — capped per run so a large backfill
// spreads across several sync runs instead of one timing out (Vercel's
// maxDuration; see api/sync-purchases/route.ts), same reasoning as sales.
const DETAIL_FETCH_BATCH_SIZE = 50;
// Same bounded-initial-backfill reasoning/value as sales (sync-sales.ts) —
// a purchase order older than this that's still open is a rare edge case,
// not the common path this needs to optimize for.
const DEFAULT_BACKFILL_MONTHS = 12;

function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString();
}

export interface PurchasesSyncSummary {
  instanceId: string;
  listSynced: number;
  detailSynced: number;
  detailFailed: number;
  errors: { purchaseId: string; error: string }[];
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * Phase 1: pulls /purchaseList (cheap, paginated, already used by System
 * Health) for every purchase order changed since this instance's last
 * synced watermark — the last `DEFAULT_BACKFILL_MONTHS` months on first run,
 * same bounded-backfill shape as sales (sync-sales.ts). Confirmed live
 * 2026-08-15 (Spark Demo instance) that `UpdatedSince` genuinely narrows
 * `/purchaseList`'s result set (100 -> 1 row with a 7-day cutoff) via its
 * `LastUpdatedDate` field — unlike `/finishedGoodsList`/
 * `/production/orderList`, which showed identical counts across every
 * cutoff and expose no comparable field, so those two stay full-scan (see
 * docs/PROJECT-NOTES.md's Phase 3.3b section). A purchase is queued for
 * phase 2 (detail_synced_at cleared) when it's new, or its
 * CombinedReceivingStatus changed since the last detail fetch (catching
 * partial -> fully received transitions). Previously skipped orders that had
 * never received anything ("NOT RECEIVED") entirely — widened 2026-07-10 for
 * the backorder-ETA feature, which specifically needs to reference open POs
 * with zero receipts yet; only a VOIDED order (Status, the workflow field —
 * not CombinedReceivingStatus) is excluded now.
 */
async function syncPurchasesList(db: SupabaseClient, orgId: string, instanceId: string, creds: Cin7Credentials): Promise<number> {
  const { data: state } = await db
    .from("purchases_sync_state")
    .select("last_list_synced_at")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .maybeSingle();

  const updatedSince: string = state?.last_list_synced_at ?? monthsAgoIso(DEFAULT_BACKFILL_MONTHS);
  // Captured before any calls, so a purchase updated mid-run isn't missed by the next run's UpdatedSince.
  const syncStartedAt = new Date().toISOString();

  const entries = await fetchAllPurchasesList(creds, updatedSince);
  const relevant = entries.filter((e) => e.CombinedReceivingStatus && e.Status !== "VOIDED");

  if (relevant.length) {
    const ids = relevant.map((e) => e.ID);
    const { data: existingRows } = await db
      .from("purchases")
      .select("cin7_purchase_id, combined_receiving_status, detail_synced_at")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .in("cin7_purchase_id", ids);
    const existingByCin7Id = new Map(
      (existingRows ?? []).map((r: { cin7_purchase_id: string; combined_receiving_status: string | null; detail_synced_at: string | null }) => [
        r.cin7_purchase_id,
        r,
      ])
    );

    const rows = relevant.map((e) => {
      const prior = existingByCin7Id.get(e.ID);
      const changed = !prior || prior.combined_receiving_status !== (e.CombinedReceivingStatus ?? null);
      return {
        org_id: orgId,
        instance_id: instanceId,
        cin7_purchase_id: e.ID,
        order_number: e.OrderNumber ?? null,
        supplier_name: e.Supplier ?? null,
        status: e.Status ?? null,
        combined_receiving_status: e.CombinedReceivingStatus ?? null,
        order_date: toDateOnly(e.OrderDate),
        required_by: toDateOnly(e.RequiredBy),
        detail_synced_at: changed ? null : (prior?.detail_synced_at ?? null),
        updated_at: new Date().toISOString(),
      };
    });

    const { error } = await db.from("purchases").upsert(rows, { onConflict: "org_id,instance_id,cin7_purchase_id" });
    if (error) throw new Error(`purchases upsert: ${error.message}`);
  }

  const { error: stateError } = await db
    .from("purchases_sync_state")
    .upsert({ org_id: orgId, instance_id: instanceId, last_list_synced_at: syncStartedAt }, { onConflict: "org_id,instance_id" });
  if (stateError) throw new Error(`purchases_sync_state upsert: ${stateError.message}`);

  return relevant.length;
}

/**
 * Phase 2: for purchases queued by phase 1, fetches actual received-stock
 * lines one at a time (rate-limited by the shared cin7Request throttle),
 * capped at DETAIL_FETCH_BATCH_SIZE per run. Replaces (delete + reinsert) a
 * purchase's receipt lines wholesale on each (re-)fetch rather than diffing
 * — a re-synced purchase's receiving history can genuinely add new batches
 * between runs, and there's no cheaper way to reconcile that.
 */
async function syncPurchaseDetails(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials
): Promise<{ synced: number; failed: number; errors: { purchaseId: string; error: string }[] }> {
  const { data: pending } = await db
    .from("purchases")
    .select("cin7_purchase_id")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .is("detail_synced_at", null)
    .order("order_date", { ascending: false })
    .limit(DETAIL_FETCH_BATCH_SIZE);

  let synced = 0;
  const errors: { purchaseId: string; error: string }[] = [];

  for (const row of (pending ?? []) as { cin7_purchase_id: string }[]) {
    try {
      const detail = await fetchPurchaseDetail(creds, row.cin7_purchase_id);

      const { error: deleteError } = await db
        .from("purchase_receipt_lines")
        .delete()
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_purchase_id", row.cin7_purchase_id);
      if (deleteError) throw new Error(`purchase_receipt_lines delete: ${deleteError.message}`);

      const lineRows = detail.receiptLines.map((line) => ({
        org_id: orgId,
        instance_id: instanceId,
        cin7_purchase_id: row.cin7_purchase_id,
        card_id: line.cardId,
        product_sku: line.productSku,
        product_name: line.productName,
        quantity: line.quantity,
        received_date: line.receivedDate,
        location: line.location,
        location_id: line.locationId,
      }));
      if (lineRows.length) {
        const { error: insertError } = await db.from("purchase_receipt_lines").insert(lineRows);
        if (insertError) throw new Error(`purchase_receipt_lines insert: ${insertError.message}`);
      }

      const { error: orderLinesDeleteError } = await db
        .from("purchase_order_lines")
        .delete()
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_purchase_id", row.cin7_purchase_id);
      if (orderLinesDeleteError) throw new Error(`purchase_order_lines delete: ${orderLinesDeleteError.message}`);

      const orderLineRows = detail.orderLines.map((line, i) => ({
        org_id: orgId,
        instance_id: instanceId,
        cin7_purchase_id: row.cin7_purchase_id,
        line_number: i,
        product_sku: line.productSku,
        product_name: line.productName,
        quantity: line.quantity,
      }));
      if (orderLineRows.length) {
        const { error: orderLinesInsertError } = await db.from("purchase_order_lines").insert(orderLineRows);
        if (orderLinesInsertError) throw new Error(`purchase_order_lines insert: ${orderLinesInsertError.message}`);
      }

      const { error: updateError } = await db
        .from("purchases")
        .update({ source: detail.source, is_drop_ship: detail.isDropShip, detail_synced_at: new Date().toISOString() })
        .eq("org_id", orgId)
        .eq("instance_id", instanceId)
        .eq("cin7_purchase_id", row.cin7_purchase_id);
      if (updateError) throw new Error(`purchases update: ${updateError.message}`);

      synced++;
    } catch (e) {
      errors.push({ purchaseId: row.cin7_purchase_id, error: e instanceof Error ? e.message : "Unknown error" });
    }
  }

  return { synced, failed: errors.length, errors };
}

/** Runs both sync phases for one instance. */
export async function syncInstancePurchases(db: SupabaseClient, orgId: string, instanceId: string): Promise<PurchasesSyncSummary> {
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const listSynced = await syncPurchasesList(db, orgId, instanceId, creds);
  const { synced, failed, errors } = await syncPurchaseDetails(db, orgId, instanceId, creds);
  return { instanceId, listSynced, detailSynced: synced, detailFailed: failed, errors };
}

/**
 * Syncs purchase receipts for active instances — every one for the org, or
 * just the given subset — mirroring sync-sales.ts's syncOrgSales shape.
 * Per-instance failures are caught so one bad instance doesn't stop others.
 *
 * Route lock (Phase 3.3a): guarded per (org, "sync-purchases") — same
 * reasoning as syncOrgSales's own route lock.
 */
export async function syncOrgPurchases(db: SupabaseClient, orgId?: string, instanceIds?: string[]): Promise<PurchasesSyncSummary[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);
  const allInstances = (instances ?? []) as { id: string; org_id: string }[];

  const runInstances = async (list: typeof allInstances) => {
    const results: PurchasesSyncSummary[] = [];
    for (const instance of list) {
      try {
        results.push(await syncInstancePurchases(db, instance.org_id, instance.id));
      } catch (e) {
        results.push({
          instanceId: instance.id,
          listSynced: 0,
          detailSynced: 0,
          detailFailed: 0,
          errors: [{ purchaseId: "-", error: e instanceof Error ? e.message : "Unknown error" }],
        });
      }
    }
    return results;
  };

  if (!orgId) return runInstances(allInstances);

  const routeLock = await acquireSyncRouteLock(db, "sync-purchases", orgId);
  if (!routeLock.acquired) return [];
  try {
    return await runInstances(allInstances);
  } finally {
    await releaseSyncRouteLock(db, "sync-purchases", orgId, routeLock.lockedAt);
  }
}
