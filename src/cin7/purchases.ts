import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed live (2026-07-06): `/purchaseList` mirrors `/saleList`'s exact
 * convention — capital-case `Page`/`Limit` query params, `PurchaseList` list
 * key. `StockReceivedStatus` looks receiving-related but is actually an
 * authorization-workflow status (its real values line up with
 * AUTHORISED/DRAFT/VOIDED, not a receiving-progress scale) —
 * `CombinedReceivingStatus` is the field that actually tracks
 * NOT RECEIVED/PARTIALLY RECEIVED/FULLY RECEIVED, confirmed by tallying real
 * values across the full live dataset.
 */
export interface Cin7PurchaseListEntry {
  ID: string;
  OrderNumber?: string;
  Status?: string;
  OrderDate?: string;
  Supplier?: string;
  SupplierID?: string;
  CombinedReceivingStatus?: string;
  /** The receiving/ETA deadline — confirmed live, populated on both received and not-yet-received orders. */
  RequiredBy?: string | null;
  /**
   * Confirmed live 2026-08-15 (Spark Demo instance): `/purchaseList` DOES
   * carry a genuine last-modified timestamp, and `UpdatedSince` genuinely
   * narrows the result set by it (100 -> 1 row with a 7-day cutoff) — unlike
   * `/finishedGoodsList`/`/production/orderList`, which showed the identical
   * row count across every cutoff tried and expose no comparable field at
   * all. See sync-purchases.ts's syncPurchasesList and
   * docs/PROJECT-NOTES.md's Phase 3.3b section for the full evidence.
   */
  LastUpdatedDate?: string;
}

/**
 * Fetches purchase orders on the account, optionally scoped to ones changed
 * since a given ISO timestamp. Paginates until a short page signals the end,
 * same pattern as fetchAllSalesList.
 */
export async function fetchAllPurchasesList(creds: Cin7Credentials, updatedSince?: string): Promise<Cin7PurchaseListEntry[]> {
  const pageSize = 100;
  const all: Cin7PurchaseListEntry[] = [];
  for (let page = 1; ; page++) {
    const query: Record<string, string | number> = { Page: page, Limit: pageSize };
    if (updatedSince) query.UpdatedSince = updatedSince;
    const response = await cin7Request<{ PurchaseList?: Cin7PurchaseListEntry[] }>(creds, "/purchaseList", { query });
    const purchases = response.PurchaseList ?? [];
    all.push(...purchases);
    if (purchases.length < pageSize) break;
  }
  return all;
}
