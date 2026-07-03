import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Ensures a minimal product row exists for a SKU referenced by a BOM import
 * (BOM CSVs don't carry full product detail — that comes from InventoryList).
 * Never overwrites an already-imported product: relies on ignoreDuplicates so
 * a real InventoryList import always wins regardless of import order.
 */
export async function ensureProductStubs(
  db: SupabaseClient,
  orgId: string,
  products: { sku: string; name: string }[]
) {
  if (!products.length) return;
  const { error } = await db
    .from("products")
    .upsert(
      products.map((p) => ({
        org_id: orgId,
        sku: p.sku,
        name: p.name || p.sku,
        type: "component" as const,
        active: true,
      })),
      { onConflict: "org_id,sku", ignoreDuplicates: true }
    );
  if (error) throw new Error(`product stub: ${error.message}`);
}
