import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";
import { fetchPurchaseDetail } from "@/cin7/purchase-detail";

/**
 * READ-ONLY source audit for Issue #206 (GET requests + cache SELECTs only; never writes to Cin7 or the
 * database). Two questions:
 *   1. CENSUS  — for POs the sync considers fresh (never relisted since their detail was fetched), do the cached
 *      ordered/received quantities still equal what Cin7 returns now?  Any difference means receiving changed
 *      without Toolbox ever seeing a relist, i.e. LastUpdatedDate/relisting is NOT sufficient on its own.
 *   2. LIST RECONCILIATION — across the whole /purchaseList: does Cin7's LastUpdatedDate reach at least the latest
 *      RECEIVING date we hold for each PO (actual receipt dates only, never invoice/due dates), and how many POs
 *      changed at the source after our last detail fetch without us relisting them? Also: voided/missing/drifted.
 */

export interface CachedTotals {
  orderLines: number;
  orderQty: number;
  receiptRows: number;
  receiptQty: number;
}

export interface CensusRow {
  orderNumber: string | null;
  purchaseId: string;
  receivingStatus: string | null;
  detailAgeDays: number | null;
  cached: CachedTotals;
  live: CachedTotals & { droppedNoCardIdLines: number; droppedNoCardIdQty: number };
  differs: boolean;
  /** What differs: "receipts", "orders" or both. */
  what: string[];
  error?: string;
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export function compareTotals(cached: CachedTotals, live: CachedTotals): { differs: boolean; what: string[] } {
  const what: string[] = [];
  if (cached.receiptRows !== live.receiptRows || round(cached.receiptQty) !== round(live.receiptQty)) what.push("receipts");
  if (cached.orderLines !== live.orderLines || round(cached.orderQty) !== round(live.orderQty)) what.push("orders");
  return { differs: what.length > 0, what };
}

/** One PO of the census: live GET (source-hinted), compared with the cache. A failed GET is reported, never treated as "no change". */
export async function auditOnePurchase(
  creds: Cin7Credentials,
  header: { purchaseId: string; orderNumber: string | null; source: string | null; receivingStatus: string | null; detailSyncedAt: string | null },
  cached: CachedTotals,
  now: Date = new Date()
): Promise<CensusRow> {
  const base = {
    orderNumber: header.orderNumber,
    purchaseId: header.purchaseId,
    receivingStatus: header.receivingStatus,
    detailAgeDays: header.detailSyncedAt ? Math.round(((now.getTime() - Date.parse(header.detailSyncedAt)) / 86400000) * 10) / 10 : null,
    cached,
  };
  try {
    const d = await fetchPurchaseDetail(creds, header.purchaseId, { sourceHint: header.source });
    const live = {
      orderLines: d.orderLines.length,
      orderQty: round(d.orderLines.reduce((n, l) => n + (Number.isFinite(l.quantity) ? l.quantity : 0), 0)),
      receiptRows: d.receiptLines.length,
      receiptQty: round(d.receiptLines.reduce((n, l) => n + (Number.isFinite(l.quantity) ? l.quantity : 0), 0)),
      droppedNoCardIdLines: d.droppedReceiptLines?.count ?? 0,
      droppedNoCardIdQty: d.droppedReceiptLines?.quantity ?? 0,
    };
    return { ...base, live, ...compareTotals(cached, live) };
  } catch (e) {
    return {
      ...base,
      live: { orderLines: 0, orderQty: 0, receiptRows: 0, receiptQty: 0, droppedNoCardIdLines: 0, droppedNoCardIdQty: 0 },
      differs: false,
      what: [],
      error: (e instanceof Error ? e.message : "Unknown error").slice(0, 160),
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// List reconciliation (pure)
// ---------------------------------------------------------------------------------------------------------------

export interface ListEntry {
  ID: string;
  OrderNumber?: string;
  Status?: string;
  CombinedReceivingStatus?: string;
  LastUpdatedDate?: string | null;
}

export interface CachedHeader {
  cin7_purchase_id: string;
  status: string | null;
  combined_receiving_status: string | null;
  updated_at: string | null;
  detail_synced_at: string | null;
  /** The latest ACTUAL receiving date held for this PO (purchase_receipt_lines.received_date), or null. */
  latest_received_date: string | null;
}

export interface ListAuditCounters {
  listed: number;
  /** In Cin7's list but not cached, excluding VOIDED and entries without a receiving status (both intentionally never cached). */
  notInCacheActive: number;
  voidedInSource: number;
  /** Voided in Cin7 but cached with a non-VOIDED status — the cache still shows them as live (the sync's void filter never updates them). */
  voidedButCachedAsActive: number;
  voidedAndNotCached: number;
  statusDrift: number;
  receivingStatusDrift: number;
  missingLastUpdated: number;
  withCachedReceipts: number;
  /** LastUpdatedDate (date part) >= the latest cached RECEIVING date — consistent with receiving bumping the timestamp. */
  lastUpdatedCoversLatestReceipt: number;
  /** LastUpdatedDate is EARLIER than a receiving date we hold — receiving did not move the timestamp (or the date is unreliable). */
  lastUpdatedBeforeLatestReceipt: number;
  /** Changed at the source after our last detail fetch (beyond a 12h timezone tolerance) while Toolbox never relisted it. */
  changedAtSourceNotRelisted: number;
  examples: { purchaseId: string; orderNumber: string | null; kind: string; lastUpdated: string | null; cached: string | null }[];
}

export function emptyCounters(): ListAuditCounters {
  return {
    listed: 0,
    notInCacheActive: 0,
    voidedInSource: 0,
    voidedButCachedAsActive: 0,
    voidedAndNotCached: 0,
    statusDrift: 0,
    receivingStatusDrift: 0,
    missingLastUpdated: 0,
    withCachedReceipts: 0,
    lastUpdatedCoversLatestReceipt: 0,
    lastUpdatedBeforeLatestReceipt: 0,
    changedAtSourceNotRelisted: 0,
    examples: [],
  };
}

/** Cin7 dates carry no timezone ("2026-07-02T10:00:00"); they are parsed as UTC and only ever compared with a tolerance. */
export function parseSourceDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(t) ? null : t;
}

const TZ_TOLERANCE_MS = 12 * 3600 * 1000;
const MAX_EXAMPLES = 8;

export function auditListEntries(entries: ListEntry[], cachedById: Map<string, CachedHeader>): ListAuditCounters {
  const c = emptyCounters();
  const note = (e: ListEntry, kind: string, cached: string | null) => {
    if (c.examples.length < MAX_EXAMPLES) c.examples.push({ purchaseId: e.ID, orderNumber: e.OrderNumber ?? null, kind, lastUpdated: e.LastUpdatedDate ?? null, cached });
  };

  for (const e of entries) {
    c.listed += 1;
    const cached = cachedById.get(e.ID);
    const voided = e.Status === "VOIDED";
    if (voided) {
      c.voidedInSource += 1;
      if (!cached) c.voidedAndNotCached += 1;
      else if (cached.status !== "VOIDED") {
        c.voidedButCachedAsActive += 1;
        note(e, "voided_in_source_cached_as_active", cached.status);
      }
      continue;
    }
    if (!e.CombinedReceivingStatus) continue; // never cached by design
    if (!cached) {
      c.notInCacheActive += 1;
      note(e, "not_in_cache", null);
      continue;
    }
    if ((cached.status ?? null) !== (e.Status ?? null)) c.statusDrift += 1;
    if ((cached.combined_receiving_status ?? null) !== (e.CombinedReceivingStatus ?? null)) c.receivingStatusDrift += 1;

    const lu = parseSourceDate(e.LastUpdatedDate);
    if (lu === null) {
      c.missingLastUpdated += 1;
      continue;
    }
    if (cached.latest_received_date) {
      c.withCachedReceipts += 1;
      if (String(e.LastUpdatedDate).slice(0, 10) >= cached.latest_received_date) c.lastUpdatedCoversLatestReceipt += 1;
      else {
        c.lastUpdatedBeforeLatestReceipt += 1;
        note(e, "last_updated_before_latest_receipt", cached.latest_received_date);
      }
    }
    const synced = cached.detail_synced_at ? Date.parse(cached.detail_synced_at) : null;
    const relisted = cached.updated_at && synced !== null ? Date.parse(cached.updated_at) - synced > 1000 : false;
    if (synced !== null && !relisted && lu > synced + TZ_TOLERANCE_MS) {
      c.changedAtSourceNotRelisted += 1;
      note(e, "changed_at_source_not_relisted", cached.detail_synced_at);
    }
  }
  return c;
}

export function mergeCounters(a: ListAuditCounters, b: ListAuditCounters): ListAuditCounters {
  const out = emptyCounters();
  for (const k of Object.keys(out) as (keyof ListAuditCounters)[]) {
    if (k === "examples") continue;
    (out[k] as number) = (a[k] as number) + (b[k] as number);
  }
  out.examples = [...a.examples, ...b.examples].slice(0, MAX_EXAMPLES);
  return out;
}

/** One page window of /purchaseList (GET). Pages are 100 entries; the audit never uses UpdatedSince so it sees EVERY purchase. */
export async function fetchPurchaseListPages(creds: Cin7Credentials, fromPage: number, pages: number): Promise<{ entries: ListEntry[]; nextPage: number | null }> {
  const entries: ListEntry[] = [];
  for (let page = fromPage; page < fromPage + pages; page++) {
    const resp = await cin7Request<{ PurchaseList?: ListEntry[] }>(creds, "/purchaseList", { query: { Page: page, Limit: 100 } });
    const batch = resp.PurchaseList ?? [];
    entries.push(...batch);
    if (batch.length < 100) return { entries, nextPage: null };
  }
  return { entries, nextPage: fromPage + pages };
}
