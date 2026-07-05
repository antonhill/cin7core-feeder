import type { SupabaseClient } from "@supabase/supabase-js";

export type ScopableKind = "products" | "customers" | "suppliers";

const NATURAL_KEY_FIELD: Record<ScopableKind, string> = {
  products: "ProductCode",
  customers: "Name",
  suppliers: "Name",
};

/**
 * Returns the natural keys (SKU for products, Name for customers/suppliers)
 * committed in the most recent import batch of the given kind — lets a push
 * scope to "just what was last imported" instead of the whole org catalog,
 * so testing one import doesn't sweep in unrelated rows and their
 * pre-existing failures. Returns null if no committed batch of that kind
 * exists yet (caller decides what "scope to nothing" should mean).
 */
export async function getLastImportKeys(db: SupabaseClient, orgId: string, kind: ScopableKind): Promise<string[] | null> {
  const { data: batch, error: batchError } = await db
    .from("import_batches")
    .select("id")
    .eq("org_id", orgId)
    .eq("kind", kind)
    .eq("status", "committed")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (batchError) throw new Error(`import_batches: ${batchError.message}`);
  if (!batch) return null;

  const { data: rows, error: rowsError } = await db
    .from("import_rows")
    .select("raw")
    .eq("batch_id", batch.id)
    .eq("status", "committed");
  if (rowsError) throw new Error(`import_rows: ${rowsError.message}`);

  const field = NATURAL_KEY_FIELD[kind];
  const keys = new Set<string>();
  for (const row of rows ?? []) {
    const key = (row.raw as Record<string, unknown>)[field];
    if (typeof key === "string" && key.trim()) keys.add(key.trim());
  }
  return [...keys];
}
