/**
 * Fulfillment Cleanup Helper — turns every negative-availability row for an
 * instance into a completed Cin7 Bulk Stock Adjustment line (same column
 * format as Cin7's own BulkUpdateStockAdjustment.csv template), so a
 * warehouse can clear a backlog of unfulfillable sales in one import instead
 * of adjusting SKUs one at a time.
 *
 * Business rule (Anton, 2026-07-10): the adjustment quantity brings
 * `available` back to exactly zero (Quantity = -available, since
 * available = on_hand - allocated). Whether a line is "Zero" or "NonZero"
 * in Cin7's own Action column depends on whether there's any real stock at
 * all right now: `on_hand <= 0` means there's nothing on the shelf, so the
 * line needs its own UnitCost (from the product's current average cost,
 * since there's no existing stock to average against); `on_hand > 0` means
 * some real stock already exists at that location even though it's still
 * oversold, so Cin7 can derive the adjustment's cost from the existing
 * weighted average — UnitCost is deliberately left blank for those lines.
 */

export interface NegativeAvailabilityRow {
  location: string | null;
  productSku: string;
  productName: string | null;
  bin: string | null;
  batchSn: string | null;
  /** Plain "YYYY-MM-DD", as product_availability stores it. */
  expiryDate: string | null;
  onHand: number;
  available: number;
}

export interface FulfillmentCleanupLine {
  action: "Zero" | "NonZero";
  location: string | null;
  productSku: string;
  productName: string | null;
  bin: string | null;
  batchSn: string | null;
  expiryDate: string | null;
  quantity: number;
  unitCost: number | null;
  comments: string;
  /** Plain "YYYY-MM-DD" — always today, since this is a fresh correction, not a historical reconstruction. */
  receivedDate: string;
}

const COMMENT = "Backorder cleanup - negative availability correction";

/** Rows with available >= 0 are filtered out defensively — callers are expected to have already scoped the query to `available < 0`, but this keeps the function correct standalone (e.g. in tests) regardless. */
export function buildFulfillmentCleanupLines(
  rows: NegativeAvailabilityRow[],
  averageCostBySku: Map<string, number>,
  todayIso: string
): FulfillmentCleanupLine[] {
  return rows
    .filter((r) => r.available < 0)
    .map((r) => {
      const isZero = r.onHand <= 0;
      return {
        action: isZero ? "Zero" : "NonZero",
        location: r.location,
        productSku: r.productSku,
        productName: r.productName,
        bin: r.bin,
        batchSn: r.batchSn,
        expiryDate: r.expiryDate,
        quantity: -r.available,
        unitCost: isZero ? (averageCostBySku.get(r.productSku) ?? null) : null,
        comments: COMMENT,
        receivedDate: todayIso,
      };
    });
}
