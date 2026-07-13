/**
 * Replenish — proposes Stock Transfers that top up locations whose stock
 * has fallen below their reorder point, pulling from one chosen source
 * location.
 *
 * Threshold resolution (Anton, 2026-07-13): Cin7 supports both a flat,
 * global reorder minimum per product (`MinimumBeforeReorder`/
 * `ReorderQuantity` on the Product itself) AND a genuine per-location
 * override (Cin7's own Reorder Level Model, an array on the Product
 * keyed by Location) — an earlier draft of this feature wrongly assumed
 * only the flat value existed. `resolveReorderThresholds` below picks
 * the location-specific entry when one exists, falling back to the
 * flat value otherwise; a (product, location) pair with neither set (or
 * set to 0) isn't a candidate at all.
 *
 * Proposed quantity tops up to `minimumBeforeReorder + reorderQuantity`,
 * not just the reorder point alone — otherwise `reorderQuantity` would be
 * a field this feature never reads, which is a strong signal it'd be the
 * wrong formula (the two fields are the classic reorder-point/
 * reorder-quantity pair, not alternatives).
 *
 * A single source location can't independently "fully" supply every
 * destination if their combined shortfall exceeds its own stock, so the
 * source's available quantity is decremented via a running allocation as
 * it's assigned across destinations for the same SKU, largest-shortfall
 * location first — the neediest location is served first when the
 * source can't cover everything. A line whose quantity had to be reduced
 * below the real shortfall is flagged `capped: true` rather than
 * silently truncated.
 */

export interface AvailabilityRow {
  location: string;
  productSku: string;
  productName: string | null;
  onHand: number;
}

export interface ReorderThreshold {
  minimumBeforeReorder: number;
  reorderQuantity: number;
}

/** A product's flat/global reorder fields plus its live-fetched per-location overrides (see src/cin7/product-reorder.ts). */
export interface ReplenishProductInput {
  sku: string;
  minimumBeforeReorder: number;
  reorderQuantity: number;
  reorderLevels: { locationName: string; minimumBeforeReorder: number; reorderQuantity: number }[];
}

export interface ReplenishLine {
  productSku: string;
  productName: string | null;
  fromLocation: string;
  toLocation: string;
  quantity: number;
  /** True when quantity was reduced below the real shortfall because the source location didn't have enough surplus. */
  capped: boolean;
}

/**
 * Resolves the effective (product, location) reorder threshold for every
 * (product, location) pair actually present in `availabilityRows` — a
 * location-specific `ReorderLevels` entry wins when present, otherwise
 * the product's own flat fields are used. A pair with a resolved
 * `minimumBeforeReorder <= 0` isn't included in `thresholds` at all (not
 * a real candidate); `skusWithNoThreshold` collects every SKU that had
 * no usable threshold anywhere (product-level or location-level) so
 * callers can surface that gap rather than it looking like "nothing
 * needs replenishing".
 */
export function resolveReorderThresholds(
  availabilityRows: Pick<AvailabilityRow, "productSku" | "location">[],
  products: ReplenishProductInput[]
): { thresholds: Map<string, ReorderThreshold>; skusWithNoThreshold: Set<string> } {
  const productBySku = new Map(products.map((p) => [p.sku, p]));
  const thresholds = new Map<string, ReorderThreshold>();
  const skusChecked = new Set<string>();
  const skusWithThreshold = new Set<string>();

  for (const row of availabilityRows) {
    skusChecked.add(row.productSku);
    const product = productBySku.get(row.productSku);
    if (!product) continue;

    const level = product.reorderLevels.find((l) => l.locationName === row.location);
    const minimumBeforeReorder = level ? level.minimumBeforeReorder : product.minimumBeforeReorder;
    const reorderQuantity = level ? level.reorderQuantity : product.reorderQuantity;

    if (minimumBeforeReorder > 0) {
      thresholds.set(`${row.productSku}::${row.location}`, { minimumBeforeReorder, reorderQuantity });
      skusWithThreshold.add(row.productSku);
    }
  }

  const skusWithNoThreshold = new Set([...skusChecked].filter((sku) => !skusWithThreshold.has(sku)));
  return { thresholds, skusWithNoThreshold };
}

/** Builds the proposed transfer lines. `thresholds` is expected to already be resolved via resolveReorderThresholds — this function just consumes the final per-location threshold, it doesn't itself decide product-level vs. location-level. */
export function buildReplenishLines(rows: AvailabilityRow[], thresholds: Map<string, ReorderThreshold>, sourceLocation: string): ReplenishLine[] {
  const rowsBySku = new Map<string, AvailabilityRow[]>();
  for (const row of rows) {
    const arr = rowsBySku.get(row.productSku) ?? [];
    arr.push(row);
    rowsBySku.set(row.productSku, arr);
  }

  const lines: ReplenishLine[] = [];

  for (const [sku, skuRows] of rowsBySku) {
    const sourceRow = skuRows.find((r) => r.location === sourceLocation);
    let sourceRemaining = sourceRow?.onHand ?? 0;

    const candidates = skuRows
      .filter((r) => r.location !== sourceLocation)
      .map((row) => {
        const threshold = thresholds.get(`${sku}::${row.location}`);
        if (!threshold) return null;
        const target = threshold.minimumBeforeReorder + (threshold.reorderQuantity || 0);
        const shortfall = target - row.onHand;
        return shortfall > 0 ? { row, shortfall } : null;
      })
      .filter((c): c is { row: AvailabilityRow; shortfall: number } => c !== null)
      .sort((a, b) => b.shortfall - a.shortfall);

    for (const { row, shortfall } of candidates) {
      const quantity = Math.min(shortfall, sourceRemaining);
      if (quantity <= 0) continue;
      sourceRemaining -= quantity;
      lines.push({
        productSku: sku,
        productName: row.productName,
        fromLocation: sourceLocation,
        toLocation: row.location,
        quantity,
        capped: quantity < shortfall,
      });
    }
  }

  return lines;
}
