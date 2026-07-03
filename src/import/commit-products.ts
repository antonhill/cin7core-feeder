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
  const products = rows.map(toCanonicalProduct);
  const priceTiers = rows.flatMap(toCanonicalPriceTiers);

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
