import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalCustomer, toCanonicalCustomerContact, type CustomerCsvRow } from "@/model/customers";
import { chunkedWrite } from "@/import/chunked-write";

export interface CommitCustomersSummary {
  customersUpserted: number;
  contactsUpserted: number;
}

/**
 * Cin7's own Customers CSV can have several rows sharing the same Name, one
 * per contact (a live customer with 10+ contacts confirmed this) — a plain
 * upsert on (org_id, name) with the whole batch in one call crashes Postgres
 * ("ON CONFLICT DO UPDATE command cannot affect row a second time") the
 * moment two same-named rows land in the same import. The customer's own
 * fields are deduped to one row per name (last row in the file wins — in
 * practice these are identical across a customer's own repeated rows,
 * only the contact differs), while every row's contact is kept via a full
 * replace-per-name into customer_contacts, mirroring how addresses work.
 */
export async function commitCustomerRows(
  db: SupabaseClient,
  orgId: string,
  rows: CustomerCsvRow[]
): Promise<CommitCustomersSummary> {
  const customersByName = new Map(rows.map((r) => [r.Name, toCanonicalCustomer(r)]));
  const customers = [...customersByName.values()];

  const { error } = await chunkedWrite(customers.map((c) => ({ ...c, org_id: orgId })), (chunk) =>
    db.from("customers").upsert(chunk, { onConflict: "org_id,name" })
  );
  if (error) throw new Error(`customers: ${error.message}`);

  const names = [...customersByName.keys()];
  if (names.length) {
    const { error: deleteError } = await db.from("customer_contacts").delete().eq("org_id", orgId).in("name", names);
    if (deleteError) throw new Error(`customer_contacts delete: ${deleteError.message}`);
  }

  const contacts = rows.map(toCanonicalCustomerContact).filter((c) => c.contact_name);
  if (contacts.length) {
    const { error: insertError } = await chunkedWrite(contacts.map((c) => ({ ...c, org_id: orgId })), (chunk) =>
      db.from("customer_contacts").insert(chunk)
    );
    if (insertError) throw new Error(`customer_contacts insert: ${insertError.message}`);
  }

  return { customersUpserted: customers.length, contactsUpserted: contacts.length };
}
