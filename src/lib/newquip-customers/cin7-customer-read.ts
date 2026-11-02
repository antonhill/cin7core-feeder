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

/**
 * The columns this lookup reads, per table. They MUST exist in the real schema: supabase/tests/newquip_customer_lookup_schema.test.sql runs against the migrated
 * database in CI and a unit test pins this list to that file. Contacts live in `customer_contacts` (migration 0015 moved them out of `customers`); `customers` has NO contact
 * or email columns. A customer is keyed by (org_id, name); a contact row carries the customer's name in its own `name` column.
 */
export const CUSTOMER_LOOKUP_COLUMNS = {
  customers: ["name", "display_name", "currency"],
  customer_contacts: ["name", "contact_name", "email", "phone", "mobile_phone", "contact_default"],
} as const;

/** Removes anything that could alter a PostgREST filter expression (commas, parentheses, wildcards, quotes). */
export const safeSearchTerm = (q: string): string => (q ?? "").replace(/[^\p{L}\p{N}\s.&'@+_-]/gu, "").replace(/[%_]/g, "").trim().slice(0, 60);

type CustomerRow = { name: string; display_name: string | null; currency: string | null };
type ContactRow = { name: string; contact_name: string | null; email: string | null; phone: string | null; mobile_phone: string | null; contact_default: boolean | null };
const CUSTOMER_COLS = CUSTOMER_LOOKUP_COLUMNS.customers.join(", ");
const CONTACT_COLS = CUSTOMER_LOOKUP_COLUMNS.customer_contacts.join(", ");
const blank = (v: string | null | undefined): string | null => (v && v.trim() ? v.trim() : null);

/**
 * Searches the org's synced customers by customer name, trading name, contact name or contact email. Organisation-scoped on BOTH tables; never returns another org's rows.
 * A customer found through a contact is returned with that customer; a customer with no contact rows is returned with null contact fields (never an error, never blank text).
 */
export async function searchSyncedCustomers(db: Db, orgId: string, query: string): Promise<CustomerHit[]> {
  const term = safeSearchTerm(query);
  if (term.length < 2) return [];
  const byName = await db.from("customers").select(CUSTOMER_COLS).eq("org_id", orgId).or(`name.ilike.*${term}*,display_name.ilike.*${term}*`).order("name", { ascending: true }).limit(20);
  if (byName.error) throw new Error(byName.error.message);
  const byContact = await db.from("customer_contacts").select("name").eq("org_id", orgId).or(`contact_name.ilike.*${term}*,email.ilike.*${term}*`).limit(40);
  if (byContact.error) throw new Error(byContact.error.message);
  const have = new Map(((byName.data ?? []) as unknown as CustomerRow[]).map((c) => [c.name, c]));
  const viaContact = [...new Set(((byContact.data ?? []) as Array<{ name: string }>).map((c) => c.name))].filter((n) => !have.has(n));
  if (viaContact.length > 0) {
    const more = await db.from("customers").select(CUSTOMER_COLS).eq("org_id", orgId).in("name", viaContact.slice(0, 20)).order("name", { ascending: true });
    if (more.error) throw new Error(more.error.message);
    for (const c of (more.data ?? []) as unknown as CustomerRow[]) have.set(c.name, c);
  }
  const customers = [...have.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 20);
  if (customers.length === 0) return [];
  const contacts = await db.from("customer_contacts").select(CONTACT_COLS).eq("org_id", orgId).in("name", customers.map((c) => c.name));
  if (contacts.error) throw new Error(contacts.error.message);
  const best = new Map<string, ContactRow>();
  const matches = (c: ContactRow) => [c.contact_name, c.email].some((v) => (v ?? "").toLowerCase().includes(term.toLowerCase()));
  for (const c of (contacts.data ?? []) as unknown as ContactRow[]) {
    const cur = best.get(c.name);
    // prefer the contact that matched the search, then the customer's default contact, then the first one seen
    const score = (x: ContactRow) => (matches(x) ? 2 : 0) + (x.contact_default ? 1 : 0);
    if (!cur || score(c) > score(cur)) best.set(c.name, c);
  }
  return customers.map((c) => {
    const k = best.get(c.name);
    return { name: c.name, tradingName: blank(c.display_name), contactName: blank(k?.contact_name), email: blank(k?.email), phone: blank(k?.phone) ?? blank(k?.mobile_phone), currency: blank(c.currency) };
  });
}

/** Live GET of ONE customer by exact (case-insensitive) Name from the NewQuip Cin7 instance. Null when there is no match; an error when the match is ambiguous. */
export async function readCin7Customer(db: Db, orgId: string, name: string): Promise<Record<string, unknown> | null> {
  const instanceId = await singleActiveInstanceId(db, orgId);
  if (instanceId !== NEWQUIP_POC_CIN7_INSTANCE_ID) throw new Error("Customers can only be read from the expected NewQuip POC Cin7 instance; it is not.");
  const creds = await loadCin7Credentials(db as never, orgId, instanceId);
  return fetchCustomerRecordByName(creds, name);
}
