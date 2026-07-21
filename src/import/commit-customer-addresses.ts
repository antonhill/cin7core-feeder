import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalCustomerAddress, type CustomerAddressCsvRow } from "@/model/customer-addresses";
import { chunkedWrite } from "@/import/chunked-write";

export interface CommitCustomerAddressesSummary {
  addressesUpserted: number;
  customersReplaced: number;
}

function isDeleteAction(action: string): boolean {
  return action.trim().toLowerCase() === "delete";
}

/** Same full-replace-per-name approach as commitSupplierAddressRows — see that file's comment. */
export async function commitCustomerAddressRows(
  db: SupabaseClient,
  orgId: string,
  rows: CustomerAddressCsvRow[]
): Promise<CommitCustomerAddressesSummary> {
  const names = [...new Set(rows.map((r) => r.Name))];
  if (names.length) {
    const { error } = await db.from("customer_addresses").delete().eq("org_id", orgId).in("name", names);
    if (error) throw new Error(`customer_addresses delete: ${error.message}`);
  }

  const toInsert = rows.filter((r) => !isDeleteAction(r.Action)).map(toCanonicalCustomerAddress);
  if (toInsert.length) {
    const { error } = await chunkedWrite(toInsert.map((a) => ({ ...a, org_id: orgId })), (chunk) =>
      db.from("customer_addresses").insert(chunk)
    );
    if (error) throw new Error(`customer_addresses insert: ${error.message}`);
  }

  return { addressesUpserted: toInsert.length, customersReplaced: names.length };
}
