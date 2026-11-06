import "server-only";
// NewQuip customer snapshots - persistence. LOCAL ONLY: nothing here reaches Cin7. A snapshot is appended (never updated); an approved quotation is immutable, so
// no snapshot can be captured for it (also enforced by the database guard in migration 0115). Every query is scoped by org_id.
import type { createServiceRoleClient } from "@/supabase/server";
import { hashOf } from "@/newquip/quote/baseline";
import { loadQuote } from "./quote-store";
import { snapshotHash, type CustomerSnapshot } from "./customer-snapshot";

type Db = ReturnType<typeof createServiceRoleClient>;

export interface StoredSnapshot { id: string; quote_id: string; seq: number; cin7_customer_id: string; snapshot: CustomerSnapshot; snapshot_hash: string; captured_by_email: string; captured_by_owner_email: string | null; reason: string; created_at: string }

/** True when migration 0115 is not applied yet (the snapshot table does not exist): customer features then degrade to "unavailable" instead of failing the quotation. */
const missing = (m: string | undefined) => /does not exist|schema cache|could not find the table/i.test(m ?? "");

export async function customerFeaturesAvailable(db: Db): Promise<boolean> {
  const r = await db.from("newquip_quote_customers").select("id").limit(1);
  if (!r.error) return true;
  if (missing(r.error.message)) return false;
  throw new Error(r.error.message);
}

/** "Clear selection" is an appended marker row (the table is append-only and cin7_customer_id is mandatory), never a delete: every earlier snapshot is preserved. */
export const CLEARED_CUSTOMER_ID = "(cleared)";
export const isClearedRow = (r: Pick<StoredSnapshot, "cin7_customer_id"> | null | undefined): boolean => r?.cin7_customer_id === CLEARED_CUSTOMER_ID;

async function latestRow(db: Db, orgId: string, quoteId: string): Promise<StoredSnapshot | null> {
  const r = await db.from("newquip_quote_customers").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("seq", { ascending: false }).limit(1);
  if (r.error) { if (missing(r.error.message)) return null; throw new Error(r.error.message); }
  return ((r.data ?? []) as StoredSnapshot[])[0] ?? null;
}

/** The CURRENT customer snapshot: null when none was ever selected or when the latest entry is a "cleared" marker. */
export async function latestSnapshot(db: Db, orgId: string, quoteId: string): Promise<StoredSnapshot | null> {
  const row = await latestRow(db, orgId, quoteId);
  return row && !isClearedRow(row) ? row : null;
}

export async function snapshotHistory(db: Db, orgId: string, quoteId: string): Promise<StoredSnapshot[]> {
  const r = await db.from("newquip_quote_customers").select("*").eq("org_id", orgId).eq("quote_id", quoteId).order("seq", { ascending: true });
  if (r.error) { if (missing(r.error.message)) return []; throw new Error(r.error.message); }
  return (r.data ?? []) as StoredSnapshot[];
}

/** Appends a snapshot for an EDITABLE quotation of this organisation. Returns the stored row. */
export async function appendSnapshot(
  db: Db, orgId: string, quoteId: string, snapshot: CustomerSnapshot, who: { email: string; ownerEmail?: string | null }, reason: string,
): Promise<StoredSnapshot> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state === "MANAGER_APPROVED_FINAL") throw new Error("The customer details of an approved quotation are immutable.");
  const prior = await latestRow(db, orgId, quoteId);
  const seq = (prior?.seq ?? 0) + 1;
  const ins = await db.from("newquip_quote_customers").insert({
    org_id: orgId, quote_id: quoteId, seq, cin7_customer_id: snapshot.cin7CustomerId, snapshot, snapshot_hash: snapshotHash(snapshot),
    captured_by_email: who.email, captured_by_owner_email: who.ownerEmail ?? null, reason,
  }).select("*").single();
  if (ins.error || !ins.data) throw new Error(`Could not save the customer details: ${ins.error?.message ?? "no row"}`);
  return ins.data as StoredSnapshot;
}

/** Appends a "customer cleared" marker for an EDITABLE quotation (append-only: earlier snapshots stay). The marker carries who cleared it and why. */
export async function appendClearMarker(db: Db, orgId: string, quoteId: string, who: { email: string; ownerEmail?: string | null }, reason: string): Promise<StoredSnapshot> {
  const q = await loadQuote(db, orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (q.state === "MANAGER_APPROVED_FINAL") throw new Error("The customer details of an approved quotation are immutable.");
  const prior = await latestRow(db, orgId, quoteId);
  const marker = { cleared: true, clearedAt: new Date().toISOString() };
  const ins = await db.from("newquip_quote_customers").insert({
    org_id: orgId, quote_id: quoteId, seq: (prior?.seq ?? 0) + 1, cin7_customer_id: CLEARED_CUSTOMER_ID, snapshot: marker, snapshot_hash: hashOf(marker),
    captured_by_email: who.email, captured_by_owner_email: who.ownerEmail ?? null, reason,
  }).select("*").single();
  if (ins.error || !ins.data) throw new Error(`Could not clear the customer: ${ins.error?.message ?? "no row"}`);
  return ins.data as StoredSnapshot;
}
