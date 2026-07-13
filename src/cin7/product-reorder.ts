import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

interface Cin7ProductListResponse {
  Products?: Record<string, unknown>[];
}

/**
 * One entry of Cin7's Reorder Level Model (confirmed against Cin7's own
 * Apiary API docs, 2026-07-13) — a location-specific override of the
 * product's own flat MinimumBeforeReorder/ReorderQuantity. Matched by
 * LocationName (not LocationID) to stay consistent with how every other
 * Location reference in this app is name-keyed (product_availability.location,
 * products.default_location, sales.location).
 */
export interface Cin7ReorderLevel {
  locationName: string;
  minimumBeforeReorder: number;
  reorderQuantity: number;
}

export interface ReplenishProduct {
  sku: string;
  name: string;
  /** The product's flat, global reorder minimum — the fallback for any location without its own entry in reorderLevels. */
  minimumBeforeReorder: number;
  reorderQuantity: number;
  reorderLevels: Cin7ReorderLevel[];
}

/**
 * One paginated `/Product` pass reading ReorderLevels. Confirmed live
 * 2026-07-13 that this field is present on the default `/Product`
 * response with no opt-in query flag needed (unlike BOM/Suppliers, which
 * require `IncludeBOM`/`IncludeSuppliers` — see product-cost.ts). Every
 * live product checked so far returns an empty array; a real populated
 * example hasn't been confirmed yet, so this is built against Cin7's
 * documented schema, not a verified live shape — re-check the first time
 * a real location-level override actually appears in this data.
 *
 * Live-fetched rather than read from the `products` table because
 * ReorderLevels isn't in the InventoryList CSV template this app's
 * product sync is built around — the DB has no concept of it at all.
 * Same reasoning `fetchAllProductsForCosting` already uses for
 * AverageCost (fetched live since the DB copy is only as fresh as the
 * last CSV import/export), just stronger here since this field isn't
 * CSV-synced in any form.
 */
export async function fetchAllProductsForReplenish(creds: Cin7Credentials): Promise<ReplenishProduct[]> {
  const pageSize = 100;
  const all: ReplenishProduct[] = [];
  for (let page = 1; ; page++) {
    const response = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
      query: { page, limit: pageSize },
    });
    const products = response.Products ?? [];
    for (const raw of products) all.push(toReplenishProduct(raw));
    if (products.length < pageSize) break;
  }
  return all;
}

function toReplenishProduct(raw: Record<string, unknown>): ReplenishProduct {
  const reorderLevels = ((raw.ReorderLevels as Record<string, unknown>[] | undefined) ?? []).map((entry) => ({
    locationName: String(entry.LocationName ?? ""),
    minimumBeforeReorder: Number(entry.MinimumBeforeReorder ?? 0),
    reorderQuantity: Number(entry.ReorderQuantity ?? 0),
  }));

  return {
    sku: String(raw.SKU ?? ""),
    name: String(raw.Name ?? ""),
    minimumBeforeReorder: Number(raw.MinimumBeforeReorder ?? 0),
    reorderQuantity: Number(raw.ReorderQuantity ?? 0),
    reorderLevels,
  };
}
