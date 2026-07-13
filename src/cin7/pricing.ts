import type { Cin7Credentials } from "@/cin7/types";
import { cin7Request } from "@/cin7/http";

interface Cin7ProductListResponse {
  Products?: Record<string, unknown>[];
}

export interface PricingProduct {
  productId: string;
  sku: string;
  name: string;
  category: string | null;
  supplierNames: string[];
  /** Index 0 = PriceTier1 ... index 9 = PriceTier10, matching tierLabels' own ordering. Cin7 sends 0 for a tier slot that's never been configured on this product, not null/missing — kept as 0 here rather than coerced to null since a real price legitimately can be 0. */
  priceTierValues: number[];
}

export interface PricingFetchResult {
  products: PricingProduct[];
  /**
   * The account's own configured tier names (e.g. "Retail in VAT",
   * "Wholesale", "Staff Pricing"), confirmed live 2026-07-14 via the nested
   * `PriceTiers` object every product response carries alongside the flat
   * `PriceTier1..10` fields — its key order matches `PriceTier1..10`
   * positionally (index 0's key/value pair is PriceTier1, etc.). Tier names
   * are an account-wide setting, not per-product, so this is taken from
   * whichever product happens to be first in the fetch — every product in
   * the same account carries the identical 10 names.
   */
  tierLabels: string[];
}

const FALLBACK_TIER_LABELS = Array.from({ length: 10 }, (_, i) => `Tier ${i + 1}`);

/**
 * One paginated `/Product` pass reading Category/Suppliers/PriceTier1-10 for
 * the Bulk Pricing tool. `IncludeSuppliers=true` is required for the
 * `Suppliers` array to populate at all (confirmed live 2026-07-08 in
 * product-cost.ts, reconfirmed 2026-07-14 building this feature) — the same
 * opt-in-nested-data pattern as `IncludeBOM`/`IncludeReorderLevels`.
 * `PriceTier1..10` themselves need no such flag — confirmed live they're
 * plain top-level scalar fields on the default response.
 */
export async function fetchAllProductsForPricing(creds: Cin7Credentials): Promise<PricingFetchResult> {
  const pageSize = 100;
  const products: PricingProduct[] = [];
  let tierLabels: string[] | null = null;

  for (let page = 1; ; page++) {
    const response = await cin7Request<Cin7ProductListResponse>(creds, "/Product", {
      query: { page, limit: pageSize, IncludeSuppliers: "true" },
    });
    const rawProducts = response.Products ?? [];
    for (const raw of rawProducts) {
      if (!tierLabels) tierLabels = extractTierLabels(raw);
      products.push(toPricingProduct(raw));
    }
    if (rawProducts.length < pageSize) break;
  }

  return { products, tierLabels: tierLabels ?? FALLBACK_TIER_LABELS };
}

function extractTierLabels(raw: Record<string, unknown>): string[] | null {
  const namedTiers = raw.PriceTiers as Record<string, unknown> | undefined;
  if (!namedTiers) return null;
  const labels = Object.keys(namedTiers);
  return labels.length === 10 ? labels : null;
}

function toPricingProduct(raw: Record<string, unknown>): PricingProduct {
  const priceTierValues = Array.from({ length: 10 }, (_, i) => {
    const value = raw[`PriceTier${i + 1}`];
    return typeof value === "number" ? value : 0;
  });
  const suppliers = (raw.Suppliers as { SupplierName?: string }[] | undefined) ?? [];

  return {
    productId: String(raw.ID ?? ""),
    sku: String(raw.SKU ?? ""),
    name: String(raw.Name ?? ""),
    category: typeof raw.Category === "string" && raw.Category.trim() ? raw.Category.trim() : null,
    supplierNames: suppliers.map((s) => s.SupplierName).filter((n): n is string => Boolean(n)),
    priceTierValues,
  };
}
