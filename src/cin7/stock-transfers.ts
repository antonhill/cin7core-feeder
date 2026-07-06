import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

/**
 * Confirmed live (2026-07-06): `/stockTransferList` (capital-case
 * `Page`/`Limit`), `StockTransferList` list key. Real `Status` value set is
 * exactly DRAFT/ORDERED/IN TRANSIT/COMPLETED/VOIDED — no deadline field on
 * the list endpoint (a `RequiredByDate` exists but only on the per-record
 * detail endpoint, `GET /stocktransfer?TaskID=` — deliberately not fetched
 * here, since the health check only needs status, not a deadline, for this
 * resource; see docs/PROJECT-NOTES.md-style research notes if that changes).
 */
export interface Cin7StockTransferListEntry {
  TaskID: string;
  Number?: string;
  Status?: string;
  FromLocation?: string;
  ToLocation?: string;
  DepartureDate?: string | null;
  CompletionDate?: string | null;
}

/** Fetches every stock transfer on the account. Paginates until a short page signals the end, same pattern as fetchAllSalesList. */
export async function fetchAllStockTransfersList(creds: Cin7Credentials): Promise<Cin7StockTransferListEntry[]> {
  const pageSize = 100;
  const all: Cin7StockTransferListEntry[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<{ StockTransferList?: Cin7StockTransferListEntry[] }>(creds, "/stockTransferList", {
      query: { Page: page, Limit: pageSize },
    });
    const transfers = response.StockTransferList ?? [];
    all.push(...transfers);
    if (transfers.length < pageSize) break;
  }
  return all;
}
