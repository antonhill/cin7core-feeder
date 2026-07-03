import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalAssemblyBomLine, type AssemblyBomCsvRow } from "@/model/assembly-bom";
import { ensureProductStubs } from "@/import/product-stub";

export interface CommitAssemblyBomSummary {
  linesUpserted: number;
  productStubsEnsured: number;
}

export async function commitAssemblyBomRows(
  db: SupabaseClient,
  orgId: string,
  rows: AssemblyBomCsvRow[]
): Promise<CommitAssemblyBomSummary> {
  const parentProducts = dedupeProducts(rows.map((r) => ({ sku: r.ProductSKU, name: r.ProductName })));
  await ensureProductStubs(db, orgId, parentProducts);

  const lines = rows.map(toCanonicalAssemblyBomLine);
  const { error } = await db
    .from("assembly_bom_lines")
    .upsert(
      lines.map((l) => ({ ...l, org_id: orgId })),
      { onConflict: "org_id,product_sku,component_sku" }
    );
  if (error) throw new Error(`assembly_bom_lines: ${error.message}`);

  return { linesUpserted: lines.length, productStubsEnsured: parentProducts.length };
}

function dedupeProducts(products: { sku: string; name: string }[]) {
  const seen = new Map<string, { sku: string; name: string }>();
  for (const p of products) seen.set(p.sku, p);
  return [...seen.values()];
}
