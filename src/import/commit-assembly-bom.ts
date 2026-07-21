import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalAssemblyBomLine, type AssemblyBomCsvRow, type CanonicalAssemblyBomLine } from "@/model/assembly-bom";
import { chunkedWrite } from "@/import/chunked-write";

export interface CommitAssemblyBomSummary {
  linesUpserted: number;
  linesDeleted: number;
  /** Rows dropped because a later row in the same file shared its (ProductSKU, ComponentSKU) — see the dedupe comment below for why this exists. */
  duplicatesReplaced: number;
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

  let duplicatesReplaced = 0;
  let linesUpserted = 0;

  if (upsertRows.length) {
    const lines = upsertRows.map(toCanonicalAssemblyBomLine);

    // A single bulk .upsert() call generates one INSERT ... ON CONFLICT DO
    // UPDATE statement — if two rows in the same file share the same
    // (product_sku, component_sku) conflict key, Postgres throws "ON
    // CONFLICT DO UPDATE command cannot affect row a second time" and the
    // WHOLE batch fails with zero rows written, even though only one pair
    // was actually duplicated. Confirmed live 2026-07-13: a real client
    // upload failed exactly this way over a single accidental duplicate
    // line. Dedupe here, keeping the LAST occurrence — matches how a human
    // editing/appending to a CSV by hand would expect a later row to
    // supersede an earlier one — rather than letting one stray duplicate
    // line silently kill an otherwise-valid import.
    const bySkuPair = new Map<string, CanonicalAssemblyBomLine>();
    for (const line of lines) {
      const key = `${line.product_sku}::${line.component_sku}`;
      if (bySkuPair.has(key)) duplicatesReplaced++;
      bySkuPair.set(key, line);
    }
    const dedupedLines = [...bySkuPair.values()];
    linesUpserted = dedupedLines.length;

    const { error } = await chunkedWrite(dedupedLines.map((l) => ({ ...l, org_id: orgId })), (chunk) =>
      db.from("assembly_bom_lines").upsert(chunk, { onConflict: "org_id,product_sku,component_sku" })
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

  return { linesUpserted, linesDeleted: deleteRows.length, duplicatesReplaced };
}
