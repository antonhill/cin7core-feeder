/**
 * Bulk Reorder Points — filters a live product catalog by Category/Brand/
 * search, then sets one chosen location's `MinimumBeforeReorder`/
 * `ReorderQuantity` across every selected product (creating a new
 * per-location entry if the product doesn't have one for that location
 * yet, updating it in place otherwise).
 *
 * Safety-critical design point, confirmed live 2026-07-14 against a real
 * multi-location product (see src/cin7/product-reorder.ts's own doc
 * comment): Cin7's `ReorderLevels` field is a **full array replace**, not
 * a merge. A naive "just send the one changed entry" write silently
 * deletes every other location's reorder config on that product. Every
 * function here works with, and `buildReorderConfigLines` always returns,
 * the product's **complete** `ReorderLevels` array (existing entries
 * carried through untouched, only the target location's entry updated or
 * appended) — the write action must PUT this whole array back, never a
 * partial one.
 */

import type { Cin7ReorderLevel } from "@/cin7/product-reorder";

export interface ReorderConfigProduct {
  productId: string;
  sku: string;
  name: string;
  category: string | null;
  brand: string | null;
  reorderLevels: Cin7ReorderLevel[];
}

/** AND-combined, same convention as Data Audit/Bulk Pricing's category+search filters. An empty filter array means "no restriction on this dimension." */
export function filterReorderConfigProducts(
  products: ReorderConfigProduct[],
  categoryFilter: string[],
  brandFilter: string[],
  search: string
): ReorderConfigProduct[] {
  const needle = search.trim().toLowerCase();
  return products.filter((p) => {
    if (categoryFilter.length > 0 && !(p.category && categoryFilter.includes(p.category))) return false;
    if (brandFilter.length > 0 && !(p.brand && brandFilter.includes(p.brand))) return false;
    if (needle && !(p.sku.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))) return false;
    return true;
  });
}

export interface ReorderConfigLine {
  productId: string;
  sku: string;
  name: string;
  /** Null when this product has no existing entry for the target location yet — a new one will be created. */
  currentMinimum: number | null;
  currentReorderQuantity: number | null;
  newMinimum: number;
  newReorderQuantity: number;
  /** The product's complete ReorderLevels array with the target location's entry updated/appended — PUT this whole array back, never just the changed entry. */
  newReorderLevels: Cin7ReorderLevel[];
}

/**
 * Matched by `locationId` (not name) — both the target location (from
 * Cin7's own `/ref/location`) and each product's existing entries (from
 * the same live product fetch) carry real GUIDs, so this is unambiguous
 * even if two locations were ever similarly named. A product whose
 * resolved new values are identical to what it already has is skipped —
 * nothing to push for it.
 */
export function buildReorderConfigLines(
  products: ReorderConfigProduct[],
  selectedProductIds: Set<string>,
  targetLocationId: string,
  targetLocationName: string,
  minimumBeforeReorder: number,
  reorderQuantity: number
): ReorderConfigLine[] {
  const lines: ReorderConfigLine[] = [];

  for (const product of products) {
    if (!selectedProductIds.has(product.productId)) continue;

    const existing = product.reorderLevels.find((l) => l.locationId === targetLocationId);
    if (existing && existing.minimumBeforeReorder === minimumBeforeReorder && existing.reorderQuantity === reorderQuantity) continue;

    const newEntry: Cin7ReorderLevel = {
      locationId: targetLocationId,
      locationName: targetLocationName,
      minimumBeforeReorder,
      reorderQuantity,
      stockLocator: existing?.stockLocator ?? null,
      pickZones: existing?.pickZones ?? null,
    };
    const newReorderLevels = existing ? product.reorderLevels.map((l) => (l.locationId === targetLocationId ? newEntry : l)) : [...product.reorderLevels, newEntry];

    lines.push({
      productId: product.productId,
      sku: product.sku,
      name: product.name,
      currentMinimum: existing?.minimumBeforeReorder ?? null,
      currentReorderQuantity: existing?.reorderQuantity ?? null,
      newMinimum: minimumBeforeReorder,
      newReorderQuantity: reorderQuantity,
      newReorderLevels,
    });
  }

  return lines;
}
