import type { SupabaseClient } from "@supabase/supabase-js";
import { toCanonicalCustomer, type CustomerCsvRow } from "@/model/customers";

export interface CommitCustomersSummary {
  customersUpserted: number;
}

export async function commitCustomerRows(
  db: SupabaseClient,
  orgId: string,
  rows: CustomerCsvRow[]
): Promise<CommitCustomersSummary> {
  const customers = rows.map(toCanonicalCustomer);

  const { error } = await db
    .from("customers")
    .upsert(
      customers.map((c) => ({ ...c, org_id: orgId })),
      { onConflict: "org_id,name" }
    );
  if (error) throw new Error(`customers: ${error.message}`);

  return { customersUpserted: customers.length };
}
