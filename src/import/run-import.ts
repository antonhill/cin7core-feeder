import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCsv } from "@/import/csv";
import { productCsvRowSchema } from "@/model/products";
import { assemblyBomCsvRowSchema } from "@/model/assembly-bom";
import { productionBomCsvRowSchema } from "@/model/production-bom";
import { commitProductRows } from "@/import/commit-products";
import { commitAssemblyBomRows } from "@/import/commit-assembly-bom";
import { commitProductionBomRows } from "@/import/commit-production-bom";

export type ImportKind = "products" | "assembly_bom" | "production_bom";

export interface RunImportResult {
  batchId: string;
  kind: ImportKind;
  rowCount: number;
  errorCount: number;
  committed: boolean;
  commitSummary?: Record<string, number>;
  invalidRows: { rowNumber: number; errors: string[] }[];
}

const SCHEMAS = {
  products: productCsvRowSchema,
  assembly_bom: assemblyBomCsvRowSchema,
  production_bom: productionBomCsvRowSchema,
} as const;

/**
 * Parses a CSV, records every row (valid or not) in import_batches/import_rows
 * for audit, and commits the valid rows to the canonical tables. Invalid rows
 * are skipped, not committed — the batch summary reports them for review.
 */
export async function runImport(
  db: SupabaseClient,
  orgId: string,
  kind: ImportKind,
  filename: string,
  csvText: string
): Promise<RunImportResult> {
  const schema = SCHEMAS[kind];
  const { valid, invalid } = parseCsv(csvText, schema as never);

  const { data: batch, error: batchError } = await db
    .from("import_batches")
    .insert({
      org_id: orgId,
      kind,
      filename,
      status: "pending",
      row_count: valid.length + invalid.length,
      error_count: invalid.length,
    })
    .select("id")
    .single();
  if (batchError) throw new Error(`import_batches: ${batchError.message}`);
  const batchId: string = batch.id;

  const rowsToInsert = [
    ...valid.map((r) => ({ batch_id: batchId, row_number: r.rowNumber, raw: r.raw, status: "valid" as const })),
    ...invalid.map((r) => ({
      batch_id: batchId,
      row_number: r.rowNumber,
      raw: r.raw,
      status: "invalid" as const,
      errors: r.errors,
    })),
  ];
  if (rowsToInsert.length) {
    const { error } = await db.from("import_rows").insert(rowsToInsert);
    if (error) throw new Error(`import_rows: ${error.message}`);
  }

  let commitSummary: Record<string, number> | undefined;
  let committed = false;

  if (valid.length) {
    try {
      const data = valid.map((r) => r.data);
      if (kind === "products") {
        commitSummary = { ...(await commitProductRows(db, orgId, data as never)) };
      } else if (kind === "assembly_bom") {
        commitSummary = { ...(await commitAssemblyBomRows(db, orgId, data as never)) };
      } else {
        commitSummary = { ...(await commitProductionBomRows(db, orgId, data as never)) };
      }
      committed = true;
      await db
        .from("import_batches")
        .update({ status: "committed" })
        .eq("id", batchId);
      await db
        .from("import_rows")
        .update({ status: "committed" })
        .eq("batch_id", batchId)
        .eq("status", "valid");
    } catch (e) {
      await db
        .from("import_batches")
        .update({ status: "failed" })
        .eq("id", batchId);
      throw e;
    }
  } else {
    await db.from("import_batches").update({ status: "validated" }).eq("id", batchId);
  }

  return {
    batchId,
    kind,
    rowCount: valid.length + invalid.length,
    errorCount: invalid.length,
    committed,
    commitSummary,
    invalidRows: invalid.map((r) => ({ rowNumber: r.rowNumber, errors: r.errors })),
  };
}
