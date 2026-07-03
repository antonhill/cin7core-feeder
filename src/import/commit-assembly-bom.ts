import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalAssemblyBomLine, type AssemblyBomCsvRow } from "@/model/assembly-bom";

export interface CommitAssemblyBomSummary {
  linesUpserted: number;
}

/** Assumes every row has already passed checkAssemblyBomReferences. */
export async function commitAssemblyBomRows(
  db: SupabaseClient,
  orgId: string,
  rows: AssemblyBomCsvRow[]
): Promise<CommitAssemblyBomSummary> {
  const lines = rows.map(toCanonicalAssemblyBomLine);
  const { error } = await db
    .from("assembly_bom_lines")
    .upsert(
      lines.map((l) => ({ ...l, org_id: orgId })),
      { onConflict: "org_id,product_sku,component_sku" }
    );
  if (error) throw new Error(`assembly_bom_lines: ${error.message}`);

  return { linesUpserted: lines.length };
}
