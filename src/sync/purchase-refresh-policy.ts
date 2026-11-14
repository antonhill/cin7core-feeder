import type { PurchaseDetail } from "@/cin7/purchase-detail";

/**
 * Pure decisions for the purchase-detail refresh (no I/O) — kept separate so every rule is unit-tested.
 */

export interface PurchaseSyncConfig {
  /** Max detail fetches per instance per cron invocation — the capacity this route reserves for itself (the other five cron routes share the same Cin7 token bucket). */
  maxPerRun: number;
  /** An open (NOT/PARTIALLY RECEIVED) PO not verified within this many hours is re-fetched even if Cin7 never relisted it. */
  openTtlHours: number;
  /** The list watermark is moved back by this many minutes so entries shifted between pages (or updated mid-run) are re-listed next cycle. Re-listing is idempotent. */
  listOverlapMinutes: number;
  /** Stop starting new fetches when less than this much of the cron time budget remains. */
  safetyMs: number;
  /**
   * After a PO returns EMPTY order lines although lines are cached (suspected void at source — NOT confirmed), do not
   * re-fetch it on the periodic TTL for this many hours. A relist, a receiving-status change or a first sync still
   * bypass it, so the backoff can never hide a source-confirmed change.
   */
  suspectVoidBackoffHours: number;
}

function intFromEnv(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

/** Defaults are deliberately conservative: 60 fetches ≈ 8% of one 15-minute token-bucket cycle (720 calls at 0.8/s). */
export function loadPurchaseSyncConfig(env: Record<string, string | undefined> = process.env): PurchaseSyncConfig {
  return {
    maxPerRun: intFromEnv(env.PURCHASE_DETAIL_MAX_PER_RUN, 60, 1, 200),
    openTtlHours: intFromEnv(env.PURCHASE_OPEN_TTL_HOURS, 24, 1, 720),
    listOverlapMinutes: intFromEnv(env.PURCHASE_LIST_OVERLAP_MINUTES, 10, 0, 60),
    safetyMs: intFromEnv(env.PURCHASE_DETAIL_SAFETY_MS, 45_000, 5_000, 120_000),
    suspectVoidBackoffHours: intFromEnv(env.PURCHASE_SUSPECT_VOID_BACKOFF_HOURS, 168, 6, 2160),
  };
}

export type RefreshReason = "unsynced" | "relisted" | "open_ttl";

export interface QueueRow {
  cin7_purchase_id: string;
  order_number: string | null;
  source: string | null;
  combined_receiving_status: string | null;
  reason: RefreshReason;
  /** When Toolbox last saw the PO relisted (null on the legacy path). */
  updated_at?: string | null;
}

export interface CachedDetailTotals {
  orderLines: number;
  orderQty: number;
  receiptRows: number;
  receiptQty: number;
}

export interface RefreshVerdict {
  /** Set when the fresh response must NOT replace the cached detail. */
  reject: { code: "zero_receipts_contradicts_status" | "receipt_section_missing" | typeof LIKELY_VOIDED_AT_SOURCE; message: string } | null;
  /** Quantities differ from what was cached. */
  changed: boolean;
  fresh: { orderLines: number; orderQty: number; receiptRows: number; receiptQty: number };
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * A previously populated PO now returns EMPTY order lines. The audit showed this is the signature of a PO voided in
 * Cin7 after it was cached (the list never reports voided POs, so nothing ever updated it) — but empty lines alone do
 * NOT establish VOIDED, so this is only ever recorded as a SUSPICION; nothing infers or writes a VOIDED status.
 */
export const LIKELY_VOIDED_AT_SOURCE = "likely_voided_at_source" as const;

/**
 * True when the periodic revalidation of a suspected-void PO should be skipped. `suspectedAt` is when the suspicion was
 * recorded. It is NEVER skipped when: it was never synced (reason unsynced), or Toolbox saw it relisted AFTER the
 * suspicion (Cin7 changed it — a source-confirmed change must be re-read immediately).
 */
export function shouldSkipSuspectVoid(row: Pick<QueueRow, "reason" | "updated_at">, suspectedAt: string | undefined): boolean {
  if (!suspectedAt) return false;
  if (row.reason === "unsynced") return false;
  const suspected = Date.parse(suspectedAt);
  if (Number.isNaN(suspected)) return false;
  const relisted = row.updated_at ? Date.parse(row.updated_at) : NaN;
  if (!Number.isNaN(relisted) && relisted > suspected) return false;
  return true;
}

export function receivingStatusImpliesReceipts(status: string | null | undefined): boolean {
  return status === "PARTIALLY RECEIVED" || status === "FULLY RECEIVED";
}

/**
 * A valid cached receipt set must never be replaced by an incomplete or self-contradictory answer.
 * `cached` is null for a never-synced PO (nothing to protect).
 *
 * Deliberately NOT rejected: a lower received quantity with receipts still present (Cin7 receipts can be
 * legitimately reversed) — the report's "Needs review" state surfaces status/quantity disagreements instead.
 */
export function assessRefresh(cached: CachedDetailTotals | null, detail: PurchaseDetail, listReceivingStatus: string | null): RefreshVerdict {
  const fresh = {
    orderLines: detail.orderLines.length,
    orderQty: round(detail.orderLines.reduce((n, l) => n + (Number.isFinite(l.quantity) ? l.quantity : 0), 0)),
    receiptRows: detail.receiptLines.length,
    receiptQty: round(detail.receiptLines.reduce((n, l) => n + (Number.isFinite(l.quantity) ? l.quantity : 0), 0)),
  };
  if (!cached) return { reject: null, changed: false, fresh };

  if (cached.receiptRows > 0 && detail.receiptSectionPresent === false) {
    return {
      reject: { code: "receipt_section_missing", message: "Response carried no receipt section while receipts are cached — kept the cached receipts." },
      changed: false,
      fresh,
    };
  }
  if (cached.receiptRows > 0 && fresh.receiptRows === 0 && receivingStatusImpliesReceipts(listReceivingStatus)) {
    return {
      reject: { code: "zero_receipts_contradicts_status", message: `Response had no receipt lines but Cin7's list status is ${listReceivingStatus} — kept the cached receipts.` },
      changed: false,
      fresh,
    };
  }
  if (cached.orderLines > 0 && fresh.orderLines === 0) {
    return {
      reject: {
        code: LIKELY_VOIDED_AT_SOURCE,
        message: "Response had no order lines while order lines are cached — suspected voided at source (NOT confirmed). Cached detail kept; re-checked on a relist or after the suspect-void backoff.",
      },
      changed: false,
      fresh,
    };
  }

  const changed =
    cached.orderLines !== fresh.orderLines ||
    cached.receiptRows !== fresh.receiptRows ||
    round(cached.orderQty) !== fresh.orderQty ||
    round(cached.receiptQty) !== fresh.receiptQty;
  return { reject: null, changed, fresh };
}

/** PostgREST/Postgres error shapes for "the function is not deployed (yet)". */
export function isMissingFunctionError(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false;
  return error.code === "PGRST202" || error.code === "42883" || /could not find the function|function .* does not exist/i.test(error.message ?? "");
}

/** Cin7 asked us to slow down (or the shared limiter refused): stop spending budget on this instance for this run. */
export function isRateLimitStop(e: unknown): boolean {
  const status = (e as { status?: number } | null)?.status;
  return status === 503 || status === 429 || (e instanceof Error && /rate limit/i.test(e.message));
}
