import "server-only";
// NewQuip customer lookup. READ-ONLY with respect to Cin7: search runs against the organisation's already-synced `customers` table (org-scoped), and the one
// live call is a GET of /customer by exact Name, used to capture the authoritative Cin7 ID, contacts and billing address for a quotation snapshot.
// There is no create/update/delete of customer master data anywhere in the NewQuip workflow (pinned by customer-read.test.ts).
import type { createServiceRoleClient } from "@/supabase/server";
import { fetchCustomerRecordByName } from "@/cin7/customers";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { NEWQUIP_POC_CIN7_INSTANCE_ID } from "@/newquip/access";
import { singleActiveInstanceId } from "@/lib/projects/cin7-adapter";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface CustomerHit { name: string; tradingName: string | null; contactName: string | null; email: string | null; phone: string | null; currency: string | null }

/** Removes anything that could alter a PostgREST filter expression (commas, parentheses, wildcards, quotes). */
export const safeSearchTerm = (q: string): string => (q ?? "").replace(/[^\p{L}\p{N}\s.&'@+_-]/gu, "").replace(/[%_]/g, "").trim().slice(0, 60);

/** Searches the org's synced customers by name, trading name, contact name or email. Organisation-scoped; never returns another org's rows. */
export async function searchSyncedCustomers(db: Db, orgId: string, query: string): Promise<CustomerHit[]> {
  const term = safeSearchTerm(query);
  if (term.length < 2) return [];
  const r = await db.from("customers").select("name, display_name, contact_name, email, phone, currency").eq("org_id", orgId)
    .or(`name.ilike.*${term}*,display_name.ilike.*${term}*,contact_name.ilike.*${term}*,email.ilike.*${term}*`).order("name", { ascending: true }).limit(20);
  if (r.error) throw new Error(r.error.message);
  return ((r.data ?? []) as Array<Record<string, string | null>>).map((c) => ({ name: String(c.name), tradingName: c.display_name ?? null, contactName: c.contact_name ?? null, email: c.email ?? null, phone: c.phone ?? null, currency: c.currency ?? null }));
}

/** Live GET of ONE customer by exact (case-insensitive) Name from the NewQuip Cin7 instance. Null when there is no match; an error when the match is ambiguous. */
export async function readCin7Customer(db: Db, orgId: string, name: string): Promise<Record<string, unknown> | null> {
  const instanceId = await singleActiveInstanceId(db, orgId);
  if (instanceId !== NEWQUIP_POC_CIN7_INSTANCE_ID) throw new Error("Customers can only be read from the expected NewQuip POC Cin7 instance; it is not.");
  const creds = await loadCin7Credentials(db as never, orgId, instanceId);
  return fetchCustomerRecordByName(creds, name);
}
