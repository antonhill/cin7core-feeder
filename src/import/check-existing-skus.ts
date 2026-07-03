import type { SupabaseClient } from "@supabase/supabase-js";

/** Returns the subset of `skus` that have no matching row in products for this org. */
export async function findMissingSkus(
  db: SupabaseClient,
  orgId: string,
  skus: string[]
): Promise<Set<string>> {
  const unique = [...new Set(skus)];
  if (!unique.length) return new Set();

  const { data, error } = await db.from("products").select("sku").eq("org_id", orgId).in("sku", unique);
  if (error) throw new Error(`products lookup: ${error.message}`);

  const existing = new Set((data ?? []).map((r: { sku: string }) => r.sku));
  return new Set(unique.filter((sku) => !existing.has(sku)));
}
