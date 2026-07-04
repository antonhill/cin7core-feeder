import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalSupplier, type SupplierCsvRow } from "@/model/suppliers";

export interface CommitSuppliersSummary {
  suppliersUpserted: number;
}

export async function commitSupplierRows(
  db: SupabaseClient,
  orgId: string,
  rows: SupplierCsvRow[]
): Promise<CommitSuppliersSummary> {
  const suppliers = rows.map(toCanonicalSupplier);

  const { error } = await db
    .from("suppliers")
    .upsert(
      suppliers.map((s) => ({ ...s, org_id: orgId })),
      { onConflict: "org_id,name" }
    );
  if (error) throw new Error(`suppliers: ${error.message}`);

  return { suppliersUpserted: suppliers.length };
}
