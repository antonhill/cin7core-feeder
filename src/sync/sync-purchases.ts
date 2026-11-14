import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllPurchasesList } from "@/cin7/purchases";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";
import type { Cin7Credentials } from "@/cin7/types";
import {
  recordPurchaseDetailFailure,
  recordPurchaseDiagnostic,
  loadRefreshSkipMaps,
  PURCHASE_REFRESH_REJECTED_ACTION,
  PURCHASE_LIKELY_VOIDED_ACTION,
  PURCHASE_REFRESH_CHANGED_ACTION,
  RECEIPT_LINES_WITHOUT_CARDID_ACTION,
} from "@/sync/purchase-detail-failure";
import {
  assessRefresh,
  isMissingFunctionError,
  isRateLimitStop,
  LIKELY_VOIDED_AT_SOURCE,
  shouldSkipSuspectVoid,
  loadPurchaseSyncConfig,
  type CachedDetailTotals,
  type PurchaseSyncConfig,
  type QueueRow,
} from "@/sync/purchase-refresh-policy";
import { acquireSyncRouteLock, releaseSyncRouteLock } from "@/lib/sync-route-lock";

// Legacy (pre-0125) selection cap: used only when the purchase_refresh_queue
// function is not deployed yet, so code and migration can ship in either order.
const LEGACY_DETAIL_FETCH_BATCH_SIZE = 50;
// How long a PO whose refresh was REJECTED (contradictory/incomplete response)
// is skipped, so it cannot occupy the head of the queue every cycle.
const REJECTED_SKIP_HOURS = 6;
// Diagnostic throttles.
const CHANGED_DIAG_WINDOW_HOURS = 24 * 7;
const NO_CARDID_DIAG_WINDOW_HOURS = 24 * 7;
const REJECTED_DIAG_WINDOW_HOURS = 24;
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
  /** Listed POs whose header Status changed since the last list (they are queued for refresh by the relist itself). */
  listStatusChanged?: number;
  /** Applied refreshes of a PO that already had detail (relisted or open-past-TTL). */
  detailRefreshed?: number;
  /** Refreshes whose quantities differed from the cache. */
  refreshChanged?: number;
  /** …of which Cin7 had NOT relisted the PO (open-TTL): evidence that LastUpdatedDate does not capture every receiving change. */
  refreshChangedWithoutRelist?: number;
  /** Responses refused because they were incomplete/contradictory — the cached detail was kept. */
  refreshRejected?: number;
  /** Fetches discarded because a newer detail was already stored. */
  skippedNewer?: number;
  /** Why the detail phase ended early, if it did. */
  stoppedEarly?: "budget" | "rate_limit" | null;
  queueReasons?: { unsynced: number; relisted: number; open_ttl: number };
  /** True when the 0125 queue function is not deployed and the legacy unsynced-only selection was used. */
  legacyQueue?: boolean;
}

function toDateOnly(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.slice(0, 10);
}

/**
 * Phase 1: pulls /purchaseList (cheap, paginated) for every purchase order changed since this instance's
 * last synced watermark — the last `DEFAULT_BACKFILL_MONTHS` months on first run. Confirmed live 2026-08-15
 * that `UpdatedSince` genuinely narrows `/purchaseList` via its `LastUpdatedDate`.
 *
 * Every listed PO is upserted, which bumps `updated_at`. That alone makes a PO whose detail was fetched
 * earlier "relisted after its detail" — the signal the refresh queue (migration 0125) uses, so ANY relist
 * (header Status change, payment/invoice stages, receiving) leads to a refetch without clearing the cached
 * detail (the report keeps showing last-known quantities, flagged Potentially stale, until it is refreshed).
 *
 * `detail_synced_at` is still cleared when the CombinedReceivingStatus changes (existing behaviour): the
 * cached quantities are then known to be wrong, so the PO shows as Incomplete until refetched.
 *
 * Pagination overlap: offset pagination over a list that is changing can skip an entry that shifts between
 * pages, and the watermark then moves past it. The watermark is therefore held back by
 * `listOverlapMinutes`, so such entries are re-listed on the next cycle (upserts are idempotent; the only cost
 * is an occasional duplicate refetch of a PO updated inside the overlap window).
 *
 * VOIDED orders (and entries without a CombinedReceivingStatus) are still excluded exactly as before — this
 * change does not touch how voided purchases are seen by downstream consumers.
 */
async function syncPurchasesList(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials,
  cfg: PurchaseSyncConfig
): Promise<{ count: number; statusChanged: number }> {
  const { data: state } = await db
    .from("purchases_sync_state")
    .select("last_list_synced_at")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .maybeSingle();

  const lastSynced: string | null = state?.last_list_synced_at ?? null;
  const updatedSince: string = lastSynced ? new Date(Date.parse(lastSynced) - cfg.listOverlapMinutes * 60_000).toISOString() : monthsAgoIso(DEFAULT_BACKFILL_MONTHS);
  // Captured before any calls, so a purchase updated mid-run isn't missed by the next run's UpdatedSince.
  const syncStartedAt = new Date().toISOString();

  const entries = await fetchAllPurchasesList(creds, updatedSince);
  const relevant = entries.filter((e) => e.CombinedReceivingStatus && e.Status !== "VOIDED");
  let statusChanged = 0;

  if (relevant.length) {
    const ids = relevant.map((e) => e.ID);
    const { data: existingRows } = await db
      .from("purchases")
      .select("cin7_purchase_id, combined_receiving_status, status, detail_synced_at")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .in("cin7_purchase_id", ids);
    const existingByCin7Id = new Map(
      (existingRows ?? []).map(
        (r: { cin7_purchase_id: string; combined_receiving_status: string | null; status?: string | null; detail_synced_at: string | null }) => [r.cin7_purchase_id, r]
      )
    );

    const rows = relevant.map((e) => {
      const prior = existingByCin7Id.get(e.ID);
      const receivingChanged = !prior || prior.combined_receiving_status !== (e.CombinedReceivingStatus ?? null);
      if (prior && (prior.status ?? null) !== (e.Status ?? null)) statusChanged += 1;
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
        detail_synced_at: receivingChanged ? null : (prior?.detail_synced_at ?? null),
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

  return { count: relevant.length, statusChanged };
}

async function loadCachedTotals(db: SupabaseClient, orgId: string, instanceId: string, purchaseId: string): Promise<CachedDetailTotals> {
  const [o, r] = await Promise.all([
    db.from("purchase_order_lines").select("quantity").eq("org_id", orgId).eq("instance_id", instanceId).eq("cin7_purchase_id", purchaseId),
    db.from("purchase_receipt_lines").select("quantity").eq("org_id", orgId).eq("instance_id", instanceId).eq("cin7_purchase_id", purchaseId),
  ]);
  if (o.error) throw new Error(`purchase_order_lines: ${o.error.message}`);
  if (r.error) throw new Error(`purchase_receipt_lines: ${r.error.message}`);
  const sum = (rows: { quantity: number | string | null }[] | null) => (rows ?? []).reduce((n, x) => n + (Number(x.quantity ?? 0) || 0), 0);
  return {
    orderLines: o.data?.length ?? 0,
    orderQty: sum(o.data as { quantity: number | string | null }[] | null),
    receiptRows: r.data?.length ?? 0,
    receiptQty: sum(r.data as { quantity: number | string | null }[] | null),
  };
}

/** The legacy selection (never-synced only) — used when the 0125 queue function is not deployed yet. */
async function loadLegacyQueue(db: SupabaseClient, orgId: string, instanceId: string): Promise<QueueRow[]> {
  const { data: pending } = await db
    .from("purchases")
    .select("cin7_purchase_id, order_number")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId)
    .is("detail_synced_at", null)
    .order("order_date", { ascending: false })
    .limit(LEGACY_DETAIL_FETCH_BATCH_SIZE);
  return ((pending ?? []) as { cin7_purchase_id: string; order_number?: string | null }[]).map((r) => ({
    cin7_purchase_id: r.cin7_purchase_id,
    order_number: r.order_number ?? null,
    source: null,
    combined_receiving_status: null,
    reason: "unsynced" as const,
  }));
}

/**
 * Phase 2: refreshes purchase detail from a prioritised queue (never synced → open POs, relisted or past the
 * TTL → closed POs relisted), capped per run and by the cron time budget, rate-limit aware.
 *
 * Replaces a PO's receipt lines AND order lines atomically (`replace_purchase_detail`, 0074) through the
 * newer-wins guard (`replace_purchase_detail_guarded`, 0125). A response is only applied when it is usable
 * (structure validated in fetchPurchaseDetail) and not contradictory (assessRefresh) — otherwise the cached
 * detail is kept and a throttled diagnostic is recorded.
 */
async function syncPurchaseDetails(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  creds: Cin7Credentials,
  cfg: PurchaseSyncConfig,
  deadlineAt: number | undefined
): Promise<Pick<PurchasesSyncSummary, "detailSynced" | "detailFailed" | "errors" | "detailRefreshed" | "refreshChanged" | "refreshChangedWithoutRelist" | "refreshRejected" | "skippedNewer" | "stoppedEarly" | "queueReasons" | "legacyQueue">> {
  let queue: QueueRow[] = [];
  let legacyQueue = false;
  // Loaded BEFORE the queue so the queue limit can be widened by the number of POs we are going to skip: suspected-void
  // POs are open with the oldest detail (head of the queue) and would otherwise starve every PO behind them.
  const skipMaps = await loadRefreshSkipMaps(db, orgId, instanceId, {
    rejectedHours: REJECTED_SKIP_HOURS,
    suspectVoidHours: cfg.suspectVoidBackoffHours,
  });
  const { data: queued, error: queueError } = await db.rpc("purchase_refresh_queue", {
    p_org_id: orgId,
    p_instance_id: instanceId,
    p_open_ttl_hours: cfg.openTtlHours,
    p_limit: cfg.maxPerRun + skipMaps.rejected.size + skipMaps.suspectVoid.size + 40,
  });
  if (queueError) {
    if (!isMissingFunctionError(queueError)) throw new Error(`purchase_refresh_queue: ${queueError.message}`);
    legacyQueue = true;
    queue = await loadLegacyQueue(db, orgId, instanceId);
  } else {
    queue = ((queued ?? []) as QueueRow[]).filter(
      (q) =>
        !skipMaps.rejected.has(q.cin7_purchase_id) &&
        // A relist / receiving-status change / first sync after the suspicion bypasses the backoff (shouldSkipSuspectVoid).
        !shouldSkipSuspectVoid(q, skipMaps.suspectVoid.get(q.cin7_purchase_id))
    );
  }
  queue = queue.slice(0, legacyQueue ? LEGACY_DETAIL_FETCH_BATCH_SIZE : cfg.maxPerRun);

  const queueReasons = { unsynced: 0, relisted: 0, open_ttl: 0 };
  for (const q of queue) queueReasons[q.reason] += 1;

  let synced = 0;
  let refreshed = 0;
  let changedCount = 0;
  let changedWithoutRelist = 0;
  let rejected = 0;
  let skippedNewer = 0;
  let stoppedEarly: "budget" | "rate_limit" | null = null;
  const errors: { purchaseId: string; error: string }[] = [];
  let guardedAvailable = !legacyQueue;

  for (const row of queue) {
    if (deadlineAt !== undefined && Date.now() > deadlineAt - cfg.safetyMs) {
      stoppedEarly = "budget";
      break;
    }
    const fetchStartedAt = new Date().toISOString();
    try {
      const detail = await fetchPurchaseDetail(creds, row.cin7_purchase_id, { sourceHint: row.source });

      // Instrumentation only: receipt lines with no CardID are still not persisted (no validated identity strategy yet).
      if (detail.droppedReceiptLines && detail.droppedReceiptLines.count > 0) {
        await recordPurchaseDiagnostic(db, {
          orgId,
          instanceId,
          action: RECEIPT_LINES_WITHOUT_CARDID_ACTION,
          purchaseId: row.cin7_purchase_id,
          summary: `${row.order_number ?? row.cin7_purchase_id}: ${detail.droppedReceiptLines.count} receipt line(s) without a CardID (${detail.droppedReceiptLines.quantity} units) were not stored`,
          detail: { order_number: row.order_number, lines: detail.droppedReceiptLines.count, quantity: detail.droppedReceiptLines.quantity, source: detail.source },
          windowHours: NO_CARDID_DIAG_WINDOW_HOURS,
        });
      }

      // Loaded for EVERY reason: a PO queued because its receiving status changed still holds cached lines that an incomplete answer must not destroy.
      const cached = await loadCachedTotals(db, orgId, instanceId, row.cin7_purchase_id);
      const verdict = assessRefresh(cached, detail, row.combined_receiving_status);
      if (verdict.reject) {
        rejected += 1;
        const suspectVoid = verdict.reject.code === LIKELY_VOIDED_AT_SOURCE;
        await recordPurchaseDiagnostic(db, {
          orgId,
          instanceId,
          // Suspected void is its own code with its own long backoff; cached detail is preserved either way (nothing is
          // replaced, no VOIDED status is inferred or written).
          action: suspectVoid ? PURCHASE_LIKELY_VOIDED_ACTION : PURCHASE_REFRESH_REJECTED_ACTION,
          purchaseId: row.cin7_purchase_id,
          summary: `Purchase refresh refused for ${row.order_number ?? row.cin7_purchase_id}: ${verdict.reject.message}`,
          detail: { order_number: row.order_number, code: verdict.reject.code, reason: row.reason, cached, fresh: verdict.fresh },
          windowHours: suspectVoid ? cfg.suspectVoidBackoffHours : REJECTED_DIAG_WINDOW_HOURS,
          // New evidence (a relist after the last suspicion) is recorded again instead of being throttled away.
          supersedeAfter: suspectVoid ? (row.updated_at ?? null) : null,
        });
        continue;
      }

      const receiptLines = detail.receiptLines.map((line) => ({
        card_id: line.cardId,
        product_sku: line.productSku,
        product_name: line.productName,
        quantity: line.quantity,
        received_date: line.receivedDate,
        location: line.location,
        location_id: line.locationId,
      }));
      const orderLines = detail.orderLines.map((line, i) => ({
        line_number: i,
        product_sku: line.productSku,
        product_name: line.productName,
        quantity: line.quantity,
      }));
      const baseArgs = {
        p_org_id: orgId,
        p_instance_id: instanceId,
        p_cin7_purchase_id: row.cin7_purchase_id,
        p_receipt_lines: receiptLines,
        p_order_lines: orderLines,
        p_source: detail.source,
        p_is_drop_ship: detail.isDropShip,
      };

      let applied = true;
      if (guardedAvailable) {
        const { data: guardedResult, error: guardedError } = await db.rpc("replace_purchase_detail_guarded", { ...baseArgs, p_fetched_at: fetchStartedAt });
        if (guardedError && isMissingFunctionError(guardedError)) {
          guardedAvailable = false;
        } else if (guardedError) {
          throw new Error(`replace_purchase_detail_guarded: ${guardedError.message}`);
        } else {
          applied = guardedResult !== false;
        }
      }
      if (!guardedAvailable) {
        const { error } = await db.rpc("replace_purchase_detail", baseArgs);
        if (error) throw new Error(`replace_purchase_detail: ${error.message}`);
      }

      if (!applied) {
        skippedNewer += 1;
        continue;
      }

      synced++;
      if (row.reason !== "unsynced") refreshed++;
      if (verdict.changed && row.reason !== "unsynced") {
        changedCount++;
        if (row.reason === "open_ttl") {
          changedWithoutRelist++;
          await recordPurchaseDiagnostic(db, {
            orgId,
            instanceId,
            action: PURCHASE_REFRESH_CHANGED_ACTION,
            purchaseId: row.cin7_purchase_id,
            summary: `${row.order_number ?? row.cin7_purchase_id}: quantities changed in Cin7 without the PO being relisted`,
            detail: { order_number: row.order_number, receiving_status: row.combined_receiving_status, before: cached, after: verdict.fresh },
            windowHours: CHANGED_DIAG_WINDOW_HOURS,
          });
        }
      }
    } catch (e) {
      errors.push({ purchaseId: row.cin7_purchase_id, error: e instanceof Error ? e.message : "Unknown error" });
      // Previously invisible: per-PO failures only lived in the cron response body (nine POs failed unseen for months).
      await recordPurchaseDetailFailure(db, { orgId, instanceId, purchaseId: row.cin7_purchase_id, orderNumber: row.order_number ?? null, error: e });
      if (isRateLimitStop(e)) {
        stoppedEarly = "rate_limit";
        break;
      }
    }
  }

  return {
    detailSynced: synced,
    detailFailed: errors.length,
    errors,
    detailRefreshed: refreshed,
    refreshChanged: changedCount,
    refreshChangedWithoutRelist: changedWithoutRelist,
    refreshRejected: rejected,
    skippedNewer,
    stoppedEarly,
    queueReasons,
    legacyQueue,
  };
}

/** Runs both sync phases for one instance. */
export async function syncInstancePurchases(
  db: SupabaseClient,
  orgId: string,
  instanceId: string,
  options: { deadlineAt?: number; config?: PurchaseSyncConfig } = {}
): Promise<PurchasesSyncSummary> {
  const cfg = options.config ?? loadPurchaseSyncConfig();
  const creds = await loadCin7Credentials(db, orgId, instanceId);
  const list = await syncPurchasesList(db, orgId, instanceId, creds, cfg);
  const detail = await syncPurchaseDetails(db, orgId, instanceId, creds, cfg, options.deadlineAt);
  return { instanceId, listSynced: list.count, listStatusChanged: list.statusChanged, ...detail };
}

/**
 * Syncs purchase receipts for active instances — every one for the org, or just the given subset — mirroring
 * sync-sales.ts's syncOrgSales shape. Per-instance failures are caught so one bad instance doesn't stop others.
 *
 * `budgetMs` is what the cron rotation has LEFT of its time budget: the detail phase stops starting new
 * fetches once less than `safetyMs` remains (the rotation's own warning about handlers that ignore the budget
 * applies here too).
 *
 * Route lock (Phase 3.3a): guarded per (org, "sync-purchases") — same reasoning as syncOrgSales's own route lock.
 * That lock is also what keeps two refreshers of the same org from overlapping; the 0125 guard additionally
 * refuses to let an older fetch overwrite a newer stored detail.
 */
export async function syncOrgPurchases(db: SupabaseClient, orgId?: string, instanceIds?: string[], budgetMs?: number): Promise<PurchasesSyncSummary[]> {
  let query = db.from("cin7_instances").select("id, org_id").eq("active", true);
  if (orgId) query = query.eq("org_id", orgId);
  if (instanceIds?.length) query = query.in("id", instanceIds);
  const { data: instances, error } = await query;
  if (error) throw new Error(error.message);
  const allInstances = (instances ?? []) as { id: string; org_id: string }[];
  const deadlineAt = budgetMs !== undefined ? Date.now() + budgetMs : undefined;
  const config = loadPurchaseSyncConfig();

  const runInstances = async (list: typeof allInstances) => {
    const results: PurchasesSyncSummary[] = [];
    for (const instance of list) {
      try {
        results.push(await syncInstancePurchases(db, instance.org_id, instance.id, { deadlineAt, config }));
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
