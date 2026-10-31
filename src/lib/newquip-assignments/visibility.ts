// Quotation visibility for a Rep DERIVED FROM CUSTOMER ASSIGNMENT - not from who created the quotation. A Rep sees a quotation when its CURRENT customer (the latest
// newquip_quote_customers snapshot, and not a "(cleared)" marker) is one of the Rep's ACTIVE assignments. History follows the customer: every revision, issued document and
// response of an assigned customer's quotations is visible; when the assignment ends, all of it disappears on the next read. A quotation with no customer yet is visible to nobody
// through this boundary (enquiries are a later slice). Nothing here grants authority to edit, approve, issue or accept, and every query is scoped by organisation.
// Fails closed: a Rep with no assignments, an unapplied migration, or an unknown quotation yields nothing.
import type { createServiceRoleClient } from "@/supabase/server";
import { activeAssignmentsForRep, type AssignmentRow } from "./assignment-store";
import { CLEARED_CUSTOMER_ID } from "@/lib/newquip-quotes/customer-store";

type Db = ReturnType<typeof createServiceRoleClient>;
const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");

/** One generic denial for "does not exist" AND "exists but you may not see it", so a Rep can never probe for other customers' quotations. */
export class NotVisibleError extends Error { constructor() { super("Quote not found."); this.name = "NotVisibleError"; } }

const PAGE = 1000;
const CHUNK = 100;
type SnapRow = { quote_id: string; seq: number; cin7_customer_id: string };

/** PostgREST silently caps a select at its max-rows, so every unbounded read here is paged explicitly. */
async function pageAll(read: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<SnapRow[]> {
  const out: SnapRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const r = await read(from, from + PAGE - 1);
    if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
    const rows = (r.data ?? []) as SnapRow[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}
const chunks = <T,>(xs: T[], n: number): T[][] => { const o: T[][] = []; for (let i = 0; i < xs.length; i += n) o.push(xs.slice(i, i + n)); return o; };

/** The Cin7 customer ids a Rep may see now. */
export async function assignedCustomerIds(db: Db, orgId: string, repUserId: string): Promise<Set<string>> {
  return new Set((await activeAssignmentsForRep(db, orgId, repUserId)).map((a) => a.cin7_customer_id));
}

/** The assignments themselves (for the "my customers" list). */
export const assignedCustomers = (db: Db, orgId: string, repUserId: string): Promise<AssignmentRow[]> => activeAssignmentsForRep(db, orgId, repUserId);

/** The customer a quotation currently belongs to: its latest snapshot, or null when none was chosen or the selection was cleared. */
export async function currentCustomerIdOfQuote(db: Db, orgId: string, quoteId: string): Promise<string | null> {
  const r = await db.from("newquip_quote_customers").select("quote_id, seq, cin7_customer_id").eq("org_id", orgId).eq("quote_id", quoteId).order("seq", { ascending: false }).limit(1);
  if (r.error) { if (missing(r.error.message)) return null; throw new Error(r.error.message); }
  const row = ((r.data ?? []) as SnapRow[])[0];
  return row && row.cin7_customer_id !== CLEARED_CUSTOMER_ID ? row.cin7_customer_id : null;
}

/** Quotation ids whose CURRENT customer is in `customerIds`. */
export async function quoteIdsForCustomers(db: Db, orgId: string, customerIds: ReadonlySet<string>): Promise<string[]> {
  if (customerIds.size === 0) return [];
  // 1. every quotation that EVER pointed at one of the customers (candidates)
  const candidates = new Set<string>();
  for (const part of chunks([...customerIds], CHUNK)) {
    const rows = await pageAll((from, to) => db.from("newquip_quote_customers").select("quote_id, seq, cin7_customer_id").eq("org_id", orgId).in("cin7_customer_id", part).order("quote_id").order("seq").range(from, to));
    for (const r of rows) candidates.add(r.quote_id);
  }
  if (candidates.size === 0) return [];
  // 2. keep only those whose LATEST snapshot is still one of the customers (a quotation moved to another customer, or cleared, drops out)
  const latest = new Map<string, SnapRow>();
  for (const part of chunks([...candidates], CHUNK)) {
    const rows = await pageAll((from, to) => db.from("newquip_quote_customers").select("quote_id, seq, cin7_customer_id").eq("org_id", orgId).in("quote_id", part).order("quote_id").order("seq").range(from, to));
    for (const r of rows) { const cur = latest.get(r.quote_id); if (!cur || r.seq > cur.seq) latest.set(r.quote_id, r); }
  }
  return [...latest.values()].filter((r) => customerIds.has(r.cin7_customer_id)).map((r) => r.quote_id);
}

/** Quotation ids a Rep may see: those of their actively assigned customers, whoever created them. */
export async function visibleQuoteIdsForRep(db: Db, orgId: string, repUserId: string): Promise<string[]> {
  return quoteIdsForCustomers(db, orgId, await assignedCustomerIds(db, orgId, repUserId));
}

export async function canRepSeeQuote(db: Db, orgId: string, repUserId: string, quoteId: string): Promise<boolean> {
  const customer = await currentCustomerIdOfQuote(db, orgId, quoteId);
  if (!customer) return false;
  return (await assignedCustomerIds(db, orgId, repUserId)).has(customer);
}

/** Throws the generic NotVisibleError unless the Rep may see the quotation. Call this BEFORE loading any quotation data. */
export async function assertRepCanSeeQuote(db: Db, orgId: string, repUserId: string, quoteId: string): Promise<void> {
  if (!(await canRepSeeQuote(db, orgId, repUserId, quoteId))) throw new NotVisibleError();
}

/** Throws the generic NotVisibleError unless the Rep is actively assigned to the customer. */
export async function assertRepAssignedToCustomer(db: Db, orgId: string, repUserId: string, cin7CustomerId: string): Promise<void> {
  if (!(await assignedCustomerIds(db, orgId, repUserId)).has(cin7CustomerId)) throw new NotVisibleError();
}
