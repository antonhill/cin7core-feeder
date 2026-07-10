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
 *
 * Per-sale exclusion (Anton, 2026-07-10): some backordered sales should
 * legitimately stay unfulfilled, so their share of a SKU's negative
 * availability shouldn't be "corrected" away. product_availability itself
 * has no concept of which sale caused a shortfall — it's a location-level
 * aggregate — so exclusion works by fraction: for each SKU, compare the
 * total backorder quantity across every open sale carrying that SKU
 * against the total from only the NOT-excluded sales, and scale that SKU's
 * real availability deficit by whatever fraction of its known demand is
 * still "kept". A SKU with no known backorder demand at all (its negative
 * availability isn't explained by any open sale — e.g. a stock-count
 * issue) keeps its full deficit unchanged, since there's nothing to
 * exclude it from.
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

/** One (sale, SKU) pair with an outstanding backorder — the demand-side counterpart to a NegativeAvailabilityRow's supply-side shortfall. */
export interface BackorderDemandRow {
  cin7SaleId: string;
  productSku: string;
  backorderQty: number;
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

/** 1 (unchanged) when a SKU has no known backorder demand at all, or when nothing contributing to it was excluded; otherwise the fraction of its known demand that's still included. */
function computeFractionKeptBySku(backorderDemand: BackorderDemandRow[], excludedSaleIds: ReadonlySet<string>): Map<string, number> {
  const totalAll = new Map<string, number>();
  const totalIncluded = new Map<string, number>();
  for (const d of backorderDemand) {
    totalAll.set(d.productSku, (totalAll.get(d.productSku) ?? 0) + d.backorderQty);
    if (!excludedSaleIds.has(d.cin7SaleId)) {
      totalIncluded.set(d.productSku, (totalIncluded.get(d.productSku) ?? 0) + d.backorderQty);
    }
  }
  const fractions = new Map<string, number>();
  for (const [sku, total] of totalAll) {
    fractions.set(sku, total > 0 ? (totalIncluded.get(sku) ?? 0) / total : 1);
  }
  return fractions;
}

/** Rows with available >= 0 are filtered out defensively — callers are expected to have already scoped the query to `available < 0`, but this keeps the function correct standalone (e.g. in tests) regardless. A row whose adjusted quantity rounds down to zero (every sale contributing to it was excluded) is dropped from the output entirely rather than emitted as a zero-quantity line. */
export function buildFulfillmentCleanupLines(
  rows: NegativeAvailabilityRow[],
  averageCostBySku: Map<string, number>,
  todayIso: string,
  backorderDemand: BackorderDemandRow[] = [],
  excludedSaleIds: ReadonlySet<string> = new Set()
): FulfillmentCleanupLine[] {
  const fractionKeptBySku = computeFractionKeptBySku(backorderDemand, excludedSaleIds);

  const lines: FulfillmentCleanupLine[] = [];
  for (const r of rows) {
    if (r.available >= 0) continue;
    const fraction = fractionKeptBySku.get(r.productSku) ?? 1;
    const quantity = Math.round(-r.available * fraction);
    if (quantity <= 0) continue;

    const isZero = r.onHand <= 0;
    lines.push({
      action: isZero ? "Zero" : "NonZero",
      location: r.location,
      productSku: r.productSku,
      productName: r.productName,
      bin: r.bin,
      batchSn: r.batchSn,
      expiryDate: r.expiryDate,
      quantity,
      unitCost: isZero ? (averageCostBySku.get(r.productSku) ?? null) : null,
      comments: COMMENT,
      receivedDate: todayIso,
    });
  }
  return lines;
}
