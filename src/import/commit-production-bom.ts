import type { SupabaseClient } from "@supabase/supabase-js";
import {
  dedupeBy,
  toCanonicalItem,
  toCanonicalOperation,
  toCanonicalVersion,
  type ProductionBomCsvRow,
} from "@/model/production-bom";
import { chunkedWrite } from "@/import/chunked-write";

export interface CommitProductionBomSummary {
  versionsUpserted: number;
  operationsUpserted: number;
  itemsUpserted: number;
}

/** Assumes every row has already passed checkProductionBomReferences. */
export async function commitProductionBomRows(
  db: SupabaseClient,
  orgId: string,
  rows: ProductionBomCsvRow[]
): Promise<CommitProductionBomSummary> {
  const versions = dedupeBy(rows.map(toCanonicalVersion), (v) => [v.product_sku, v.version]);
  const { error: versionsError } = await chunkedWrite(versions.map((v) => ({ ...v, org_id: orgId })), (chunk) =>
    db.from("production_bom_versions").upsert(chunk, { onConflict: "org_id,product_sku,version" })
  );
  if (versionsError) throw new Error(`production_bom_versions: ${versionsError.message}`);

  const operations = dedupeBy(rows.map(toCanonicalOperation), (o) => [o.product_sku, o.version, o.operation_sequence]);
  const { error: operationsError } = await chunkedWrite(operations.map((o) => ({ ...o, org_id: orgId })), (chunk) =>
    db.from("production_bom_operations").upsert(chunk, { onConflict: "org_id,product_sku,version,operation_sequence" })
  );
  if (operationsError) throw new Error(`production_bom_operations: ${operationsError.message}`);

  const items = rows.map(toCanonicalItem);
  const { error: itemsError } = await chunkedWrite(items.map((i) => ({ ...i, org_id: orgId })), (chunk) =>
    db.from("production_bom_items").upsert(chunk, { onConflict: "org_id,product_sku,version,operation_sequence,item_type,item_code" })
  );
  if (itemsError) throw new Error(`production_bom_items: ${itemsError.message}`);

  return {
    versionsUpserted: versions.length,
    operationsUpserted: operations.length,
    itemsUpserted: items.length,
  };
}
