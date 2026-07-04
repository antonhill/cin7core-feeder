import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalSupplierAddress, type SupplierAddressCsvRow } from "@/model/supplier-addresses";

export interface CommitSupplierAddressesSummary {
  addressesUpserted: number;
  suppliersReplaced: number;
}

function isDeleteAction(action: string): boolean {
  return action.trim().toLowerCase() === "delete";
}

/**
 * Address rows have no stable natural key across duplicates of the same
 * (name, AddressType) — Cin7's own export can list several addresses of the
 * same type for one supplier, only one flagged AddressDefaultForType. So
 * this isn't a per-row upsert: every Name present in the file has ALL of its
 * existing stored addresses deleted, then the file's own rows (minus any
 * marked Delete) reinserted — a full replace per name, matching how Cin7
 * itself re-exports the complete current address list every time.
 */
export async function commitSupplierAddressRows(
  db: SupabaseClient,
  orgId: string,
  rows: SupplierAddressCsvRow[]
): Promise<CommitSupplierAddressesSummary> {
  const names = [...new Set(rows.map((r) => r.Name))];
  if (names.length) {
    const { error } = await db.from("supplier_addresses").delete().eq("org_id", orgId).in("name", names);
    if (error) throw new Error(`supplier_addresses delete: ${error.message}`);
  }

  const toInsert = rows.filter((r) => !isDeleteAction(r.Action)).map(toCanonicalSupplierAddress);
  if (toInsert.length) {
    const { error } = await db.from("supplier_addresses").insert(toInsert.map((a) => ({ ...a, org_id: orgId })));
    if (error) throw new Error(`supplier_addresses insert: ${error.message}`);
  }

  return { addressesUpserted: toInsert.length, suppliersReplaced: names.length };
}
