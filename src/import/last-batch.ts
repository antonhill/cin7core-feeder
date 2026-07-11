import type { SupabaseClient } from "@supabase/supabase-js";

export type ScopableKind = "products" | "customers" | "suppliers";

/**
 * Real bug found 2026-07-11 (Casa das Natas): a "Products = Just last
 * import" push only ever looked for the most recent import_batches row with
 * kind="products" — but Assembly BOM and Production BOM CSVs commit under
 * their own distinct kinds (see run-import.ts's ImportKind), even though
 * they affect exactly which products need pushing, same as a Products CSV.
 * A user who imports a BOM-only CSV and then pushes with "Just last import"
 * got silently scoped to whatever an EARLIER, unrelated Products CSV
 * batch happened to contain — the ~50 products from their BOM import were
 * never even queried, not "skipped as unchanged". Now "last import" for
 * products considers all three kinds and picks whichever was truly most
 * recent, matching what the user actually just did.
 */
const PRODUCT_SCOPING_KINDS = ["products", "assembly_bom", "production_bom"] as const;

const NATURAL_KEY_FIELD: Record<string, string> = {
  products: "ProductCode",
  assembly_bom: "ProductSKU",
  production_bom: "ProductSKU",
  customers: "Name",
  suppliers: "Name",
};

/**
 * Returns the natural keys (SKU for products, Name for customers/suppliers)
 * committed in the most recent import batch relevant to the given kind —
 * lets a push scope to "just what was last imported" instead of the whole
 * org catalog, so testing one import doesn't sweep in unrelated rows and
 * their pre-existing failures. Returns null if no committed batch exists
 * yet (caller decides what "scope to nothing" should mean).
 */
export async function getLastImportKeys(db: SupabaseClient, orgId: string, kind: ScopableKind): Promise<string[] | null> {
  const kinds: readonly string[] = kind === "products" ? PRODUCT_SCOPING_KINDS : [kind];

  const { data: batch, error: batchError } = await db
    .from("import_batches")
    .select("id, kind")
    .eq("org_id", orgId)
    .in("kind", kinds)
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

  const field = NATURAL_KEY_FIELD[batch.kind as string];
  const keys = new Set<string>();
  for (const row of rows ?? []) {
    const key = (row.raw as Record<string, unknown>)[field];
    if (typeof key === "string" && key.trim()) keys.add(key.trim());
  }
  return [...keys];
}
