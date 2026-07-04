import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalSupplier, toCanonicalSupplierContact, type SupplierCsvRow } from "@/model/suppliers";

export interface CommitSuppliersSummary {
  suppliersUpserted: number;
  contactsUpserted: number;
}

/** Same reasoning as commitCustomerRows — see that file's comment. */
export async function commitSupplierRows(
  db: SupabaseClient,
  orgId: string,
  rows: SupplierCsvRow[]
): Promise<CommitSuppliersSummary> {
  const suppliersByName = new Map(rows.map((r) => [r.Name, toCanonicalSupplier(r)]));
  const suppliers = [...suppliersByName.values()];

  const { error } = await db
    .from("suppliers")
    .upsert(
      suppliers.map((s) => ({ ...s, org_id: orgId })),
      { onConflict: "org_id,name" }
    );
  if (error) throw new Error(`suppliers: ${error.message}`);

  const names = [...suppliersByName.keys()];
  if (names.length) {
    const { error: deleteError } = await db.from("supplier_contacts").delete().eq("org_id", orgId).in("name", names);
    if (deleteError) throw new Error(`supplier_contacts delete: ${deleteError.message}`);
  }

  const contacts = rows.map(toCanonicalSupplierContact).filter((c) => c.contact_name);
  if (contacts.length) {
    const { error: insertError } = await db
      .from("supplier_contacts")
      .insert(contacts.map((c) => ({ ...c, org_id: orgId })));
    if (insertError) throw new Error(`supplier_contacts insert: ${insertError.message}`);
  }

  return { suppliersUpserted: suppliers.length, contactsUpserted: contacts.length };
}
