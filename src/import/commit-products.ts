import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalPriceTiers, toCanonicalProduct, type ProductCsvRow } from "@/model/products";

export interface CommitSummary {
  productsUpserted: number;
  categoriesUpserted: number;
  uomsUpserted: number;
  priceTiersUpserted: number;
}

/**
 * Commits validated InventoryList rows into products/categories/uoms/price_tiers.
 * Categories and UOMs are upserted first since products has a FK to both.
 */
export async function commitProductRows(
  db: SupabaseClient,
  orgId: string,
  rows: ProductCsvRow[]
): Promise<CommitSummary> {
  // products' real conflict key is (org_id, sku) — two rows sharing a
  // ProductCode in the same batch make the upsert below throw "ON CONFLICT
  // DO UPDATE command cannot affect row a second time" (confirmed live
  // 2026-07-21, on a Migrate pull whose source Cin7 account's /Product
  // export contained duplicate ProductCodes). Deduping here, before
  // products/priceTiers are derived, keeps both consistent with whichever
  // occurrence survives — checkDuplicateProductSkus (warnings.ts) surfaces
  // which rows were involved, so this doesn't silently hide it.
  const dedupedBySku = new Map(rows.map((r) => [r.ProductCode, r]));
  const uniqueRows = [...dedupedBySku.values()];

  const products = uniqueRows.map(toCanonicalProduct);
  const priceTiers = uniqueRows.flatMap(toCanonicalPriceTiers);

  const categoryCodes = new Set(products.map((p) => p.category_code).filter((c): c is string => !!c));
  const uomCodes = new Set(products.map((p) => p.uom_code).filter((c): c is string => !!c));

  if (categoryCodes.size) {
    const { error } = await db
      .from("categories")
      .upsert(
        [...categoryCodes].map((code) => ({ org_id: orgId, code, name: code })),
        { onConflict: "org_id,code", ignoreDuplicates: true }
      );
    if (error) throw new Error(`categories: ${error.message}`);
  }

  if (uomCodes.size) {
    const { error } = await db
      .from("uoms")
      .upsert(
        [...uomCodes].map((code) => ({ org_id: orgId, code, name: code })),
        { onConflict: "org_id,code", ignoreDuplicates: true }
      );
    if (error) throw new Error(`uoms: ${error.message}`);
  }

  const { error: productsError } = await db
    .from("products")
    .upsert(
      products.map((p) => ({ ...p, org_id: orgId })),
      { onConflict: "org_id,sku" }
    );
  if (productsError) throw new Error(`products: ${productsError.message}`);

  if (priceTiers.length) {
    const { error } = await db
      .from("price_tiers")
      .upsert(
        priceTiers.map((t) => ({ ...t, org_id: orgId })),
        { onConflict: "org_id,product_sku,tier_code" }
      );
    if (error) throw new Error(`price_tiers: ${error.message}`);
  }

  return {
    productsUpserted: products.length,
    categoriesUpserted: categoryCodes.size,
    uomsUpserted: uomCodes.size,
    priceTiersUpserted: priceTiers.length,
  };
}
