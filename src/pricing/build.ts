/**
 * Bulk Pricing — filters a live product catalog by Category/Supplier/search,
 * then proposes new values for one chosen price tier across every selected
 * product: either a single flat price applied uniformly, or a % increase
 * applied to each product's own current value in that tier.
 *
 * Two decisions confirmed with Anton before building (2026-07-14):
 * 1. Scope is one live Cin7 instance at a time, matching Data Audit's own
 *    precedent — not the canonical `price_tiers` table, which is org-wide
 *    and would push identically to every connected instance on next sync
 *    (no per-instance override exists there today).
 * 2. "Copy a price to all" means a single flat value applied uniformly,
 *    not copying one tier's value onto another tier per-product.
 */

export interface PriceableProduct {
  productId: string;
  sku: string;
  name: string;
  category: string | null;
  supplierNames: string[];
  /** Index 0 = PriceTier1 ... index 9 = PriceTier10, matching src/cin7/pricing.ts's own ordering. */
  priceTierValues: number[];
}

/** AND-combined, same convention as Data Audit's category+search filter (src/app/audit/page.tsx). An empty filter array means "no restriction on this dimension," not "match nothing." */
export function filterPriceableProducts(
  products: PriceableProduct[],
  categoryFilter: string[],
  supplierFilter: string[],
  search: string
): PriceableProduct[] {
  const needle = search.trim().toLowerCase();
  return products.filter((p) => {
    if (categoryFilter.length > 0 && !(p.category && categoryFilter.includes(p.category))) return false;
    if (supplierFilter.length > 0 && !p.supplierNames.some((s) => supplierFilter.includes(s))) return false;
    if (needle && !(p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))) return false;
    return true;
  });
}

export type PriceUpdateMode = "set" | "increase_percent";

export interface PriceUpdateLine {
  productId: string;
  sku: string;
  name: string;
  tierIndex: number;
  currentValue: number;
  newValue: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Builds the proposed new value per selected product for one tier. `mode`
 * `"set"` applies `value` uniformly (a flat price override) to every
 * selected product regardless of its current value. `mode`
 * `"increase_percent"` multiplies each product's own current value by
 * `1 + value/100` — a product whose current value is `0` (Cin7's own
 * "never configured" sentinel for this tier, not a real free price) stays
 * `0` either way, so it's naturally filtered out below rather than needing
 * a special case. A product whose computed new value doesn't actually
 * differ from its current one is skipped — nothing to push for it.
 */
export function buildPriceUpdateLines(
  products: PriceableProduct[],
  selectedProductIds: Set<string>,
  tierIndex: number,
  mode: PriceUpdateMode,
  value: number
): PriceUpdateLine[] {
  const lines: PriceUpdateLine[] = [];

  for (const product of products) {
    if (!selectedProductIds.has(product.productId)) continue;
    const currentValue = product.priceTierValues[tierIndex] ?? 0;
    const newValue = round2(mode === "set" ? value : currentValue * (1 + value / 100));
    if (newValue === currentValue) continue;

    lines.push({
      productId: product.productId,
      sku: product.sku,
      name: product.name,
      tierIndex,
      currentValue,
      newValue,
    });
  }

  return lines;
}
