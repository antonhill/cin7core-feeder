import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalAssemblyBomLine, type AssemblyBomCsvRow } from "@/model/assembly-bom";

export interface CommitAssemblyBomSummary {
  linesUpserted: number;
  linesDeleted: number;
}

function isDeleteAction(action: string): boolean {
  return action.trim().toLowerCase() === "delete";
}

/**
 * Assumes every row has already passed checkAssemblyBomReferences.
 *
 * Honors the AssemblyBOM CSV template's Action column: "Delete" removes
 * that specific component line from assembly_bom_lines (which bumps the
 * parent product's content_hash via trigger, so the next sync re-pushes the
 * BOM to Cin7 without that line) — anything else (including the default
 * "Create/Update") upserts as before.
 */
export async function commitAssemblyBomRows(
  db: SupabaseClient,
  orgId: string,
  rows: AssemblyBomCsvRow[]
): Promise<CommitAssemblyBomSummary> {
  const upsertRows = rows.filter((r) => !isDeleteAction(r.Action));
  const deleteRows = rows.filter((r) => isDeleteAction(r.Action));

  if (upsertRows.length) {
    const lines = upsertRows.map(toCanonicalAssemblyBomLine);
    const { error } = await db
      .from("assembly_bom_lines")
      .upsert(
        lines.map((l) => ({ ...l, org_id: orgId })),
        { onConflict: "org_id,product_sku,component_sku" }
      );
    if (error) throw new Error(`assembly_bom_lines upsert: ${error.message}`);
  }

  for (const row of deleteRows) {
    const { error } = await db
      .from("assembly_bom_lines")
      .delete()
      .eq("org_id", orgId)
      .eq("product_sku", row.ProductSKU)
      .eq("component_sku", row.ComponentSKU);
    if (error) throw new Error(`assembly_bom_lines delete: ${error.message}`);
  }

  return { linesUpserted: upsertRows.length, linesDeleted: deleteRows.length };
}
