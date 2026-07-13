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
  /** The closest available reference date on this list endpoint — Cin7 doesn't expose a true "created" timestamp here, only this last-modified one. */
  LastModifiedOn?: string | null;
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

export interface CreateStockTransferLine {
  sku: string;
  transferQuantity: number;
  /** Only required (server-enforced) when the product's stock at the source location is batch/serial-tracked — pass through the exact batch's own values from product_availability.batch_sn/expiry_date, never a guessed one. Omitted entirely for non-tracked stock. */
  batchSn?: string | null;
  /** Plain "YYYY-MM-DD" — must match the batchSn's own real expiry exactly, or Cin7 reports the batch as having 0 available (confirmed live: an omitted/mismatched ExpiryDate is treated as a different, non-existent batch record, not "no expiry filter"). */
  expiryDate?: string | null;
}

export interface CreateStockTransferResult {
  taskId: string;
  number: string;
  status: string;
}

/**
 * Creates a real Stock Transfer — confirmed live 2026-07-13 against Spark
 * Demo Test (a 1-unit throwaway transfer of a test SKU, "AFRICOLOGYTEST",
 * between two of its own locations):
 * - `POST /stockTransfer` (singular — distinct from the plural
 *   `/stockTransferList` read-only endpoint above).
 * - `Status` is a required request field, not server-assigned — sending
 *   `"DRAFT"` creates the transfer directly in that state in one call, no
 *   separate transition step needed. Always send `"DRAFT"` here (never a
 *   further-along status) so a created transfer is a genuine proposal a
 *   human still has to authorize/complete in Cin7, not something this
 *   feature force-executes.
 * - `FromLocation`/`ToLocation` are plain location name strings, matching
 *   every other Location reference in this app.
 * - Cin7 validates the requested quantity against the real available
 *   stock for that exact (SKU, BatchSN, ExpiryDate) server-side and
 *   rejects an over-quantity request with a clear error — this app's own
 *   client-side capping (see reports/replenish/build.ts) is a second,
 *   belt-and-suspenders safeguard, not the only one.
 */
export async function createStockTransfer(
  creds: Cin7Credentials,
  fromLocation: string,
  toLocation: string,
  lines: CreateStockTransferLine[]
): Promise<CreateStockTransferResult> {
  const response = await cin7Request<{ TaskID: string; Number: string; Status: string }>(creds, "/stockTransfer", {
    method: "POST",
    body: {
      Status: "DRAFT",
      FromLocation: fromLocation,
      ToLocation: toLocation,
      Lines: lines.map((l) => ({
        SKU: l.sku,
        TransferQuantity: l.transferQuantity,
        ...(l.batchSn ? { BatchSN: l.batchSn } : {}),
        ...(l.expiryDate ? { ExpiryDate: l.expiryDate } : {}),
      })),
    },
  });
  return { taskId: response.TaskID, number: response.Number, status: response.Status };
}
