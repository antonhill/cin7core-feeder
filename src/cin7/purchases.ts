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
}

/** Fetches every purchase order on the account. Paginates until a short page signals the end, same pattern as fetchAllSalesList. */
export async function fetchAllPurchasesList(creds: Cin7Credentials): Promise<Cin7PurchaseListEntry[]> {
  const pageSize = 100;
  const all: Cin7PurchaseListEntry[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ PurchaseList?: Cin7PurchaseListEntry[] }>(creds, "/purchaseList", {
      query: { Page: page, Limit: pageSize },
    });
    const purchases = response.PurchaseList ?? [];
    all.push(...purchases);
    if (purchases.length < pageSize) break;
  }
  return all;
}
