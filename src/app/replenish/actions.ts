"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireWriteAllowed } from "@/lib/billing";
import { logActivity } from "@/lib/activity-log";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForReplenish } from "@/cin7/product-reorder";
import { createStockTransfer, type CreateStockTransferResult } from "@/cin7/stock-transfers";
import { getProductAvailabilitySyncStatus, type ProductAvailabilitySyncStatus } from "@/reports/query";
import { syncOrgProductAvailability, type ProductAvailabilitySyncSummary } from "@/sync/sync-product-availability";
import { resolveReorderThresholds, type AvailabilityRow, type ReplenishProductInput, type ReplenishLine } from "@/reports/replenish/build";

export interface ReplenishActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ReplenishPreviewData {
  availabilityRows: AvailabilityRow[];
  products: ReplenishProductInput[];
  locations: string[];
  /** SKUs present in this instance's stock that have no usable reorder threshold anywhere (location-level or flat) — surfaced as a gap banner, not silently absent from the review table. */
  skusWithNoThreshold: string[];
}

/**
 * Fetches every raw ingredient buildReplenishLines/resolveReorderThresholds
 * (in @/reports/replenish/build, a plain pure module) needs: every
 * product_availability row for this instance (the already-synced stock
 * snapshot — same source as Stock Health, so a stale sync here means a
 * stale replenish list too), and a LIVE per-instance product fetch
 * including ReorderLevels (fetchAllProductsForReplenish) for whichever
 * SKUs actually appear in that snapshot — ReorderLevels isn't CSV-synced
 * anywhere, so there's no DB copy to fall back on, and there's no way to
 * know in advance which SKUs have a location-level override without
 * fetching all of them live. Deliberately does NOT resolve thresholds or
 * build lines itself — the client calls resolveReorderThresholds/
 * buildReplenishLines directly, so choosing a different source location
 * recomputes instantly with no extra round trip.
 */
export async function loadReplenishPreviewAction(instanceId: string): Promise<ReplenishActionResult<ReplenishPreviewData>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    const { data: rows, error } = await db
      .from("product_availability")
      .select("location, product_sku, product_name, on_hand")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .order("product_sku")
      .order("location");
    if (error) throw new Error(error.message);

    const availabilityRows: AvailabilityRow[] = (rows ?? [])
      .filter((r) => r.product_sku && r.location)
      .map((r) => ({
        location: r.location as string,
        productSku: r.product_sku as string,
        productName: r.product_name,
        onHand: r.on_hand ?? 0,
      }));

    const candidateSkus = new Set(availabilityRows.map((r) => r.productSku));
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const allProducts = await fetchAllProductsForReplenish(creds);
    const products: ReplenishProductInput[] = allProducts.filter((p) => candidateSkus.has(p.sku));

    const locations = [...new Set(availabilityRows.map((r) => r.location))].sort();
    const { skusWithNoThreshold } = resolveReorderThresholds(availabilityRows, products);

    return {
      ok: true,
      data: { availabilityRows, products, locations, skusWithNoThreshold: [...skusWithNoThreshold].sort() },
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Scoped to this one instance — same convention as Fulfillment Cleanup's own stock-sync status action. */
export async function loadReplenishSyncStatusAction(instanceId: string): Promise<ReplenishActionResult<ProductAvailabilitySyncStatus>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await getProductAvailabilitySyncStatus(db, orgId, instanceId) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** On-demand stock-level sync for just this one instance — same direct-call pattern as Fulfillment Cleanup's own trigger action. */
export async function triggerReplenishSyncAction(instanceId: string): Promise<ReplenishActionResult<ProductAvailabilitySyncSummary[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    return { ok: true, data: await syncOrgProductAvailability(db, orgId, [instanceId]) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface CreatedTransfer {
  toLocation: string;
  taskId: string;
  number: string;
  status: string;
  skus: string[];
}

/**
 * Creates the real Stock Transfer(s) in Cin7. `POST /stockTransfer` moves
 * lines between exactly one (FromLocation, ToLocation) pair per call (see
 * src/cin7/stock-transfers.ts) — since a Replenish run can propose lines
 * to several different destinations from the one chosen source, lines are
 * grouped by toLocation here and one transfer is created per destination,
 * each carrying every SKU going to that location.
 *
 * Batch/expiry resolution: build.ts's ReplenishLine has no notion of batch
 * identity (it only reasons about on-hand quantities/thresholds) — Cin7
 * only requires BatchSN/ExpiryDate when the specific product/location's
 * stock is batch-tracked, confirmed live to be a per-line, per-source-
 * location concern, so it's resolved here against product_availability
 * right before the write, not baked into the pure module. A source
 * location can have more than one open batch for the same SKU; this picks
 * the batch with the largest on_hand as the one to transfer from — a v1
 * simplification (splitting a single proposed line across multiple
 * batches is out of scope for now, same as the plan's other deferred
 * items).
 */
export async function createReplenishTransfersAction(
  instanceId: string,
  fromLocation: string,
  lines: ReplenishLine[]
): Promise<ReplenishActionResult<CreatedTransfer[]>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!fromLocation) return { ok: false, error: "Choose a source location." };
  if (!lines.length) return { ok: false, error: "Nothing to transfer." };

  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const skus = [...new Set(lines.map((l) => l.productSku))];
    const { data: batchRows, error } = await db
      .from("product_availability")
      .select("product_sku, batch_sn, expiry_date, on_hand")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("location", fromLocation)
      .in("product_sku", skus);
    if (error) throw new Error(error.message);

    const bestBatchBySku = new Map<string, { batchSn: string | null; expiryDate: string | null; onHand: number }>();
    for (const row of batchRows ?? []) {
      const sku = row.product_sku as string;
      const onHand = row.on_hand ?? 0;
      const existing = bestBatchBySku.get(sku);
      if (!existing || onHand > existing.onHand) {
        bestBatchBySku.set(sku, { batchSn: row.batch_sn, expiryDate: row.expiry_date, onHand });
      }
    }

    const linesByDestination = new Map<string, ReplenishLine[]>();
    for (const line of lines) {
      const arr = linesByDestination.get(line.toLocation) ?? [];
      arr.push(line);
      linesByDestination.set(line.toLocation, arr);
    }

    const created: CreatedTransfer[] = [];
    for (const [toLocation, destLines] of linesByDestination) {
      const result: CreateStockTransferResult = await createStockTransfer(
        creds,
        fromLocation,
        toLocation,
        destLines.map((l) => {
          const batch = bestBatchBySku.get(l.productSku);
          return {
            sku: l.productSku,
            transferQuantity: l.quantity,
            batchSn: batch?.batchSn ?? null,
            expiryDate: batch?.expiryDate ?? null,
          };
        })
      );
      created.push({ toLocation, taskId: result.taskId, number: result.number, status: result.status, skus: destLines.map((l) => l.productSku) });
    }

    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: "replenish.create_transfer",
      summary: `Created ${created.length} draft transfer${created.length === 1 ? "" : "s"} from ${fromLocation} (${lines.length} line${lines.length === 1 ? "" : "s"})`,
      detail: { fromLocation, transfers: created },
    });

    return { ok: true, data: created };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
