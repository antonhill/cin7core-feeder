"use server";

// NewQuip: Cin7 customer lookup, quotation contact selection and the immutable customer snapshot. Cin7 stays the customer master: the only Cin7 call is a GET of /customer
// (never a create/update/delete), and nothing is written back. Re-authorised inside EVERY action: the NewQuip org check, then the Rep role (the effective Demo user when
// Demo Mode is on). A quotation of another organisation is indistinguishable from "not found". Only async functions and erased types are exported.
import { authoriseActor, auditActor, errText, ownerEmailOf, type Actor, type Db } from "./actor";
import { createServiceRoleClient } from "@/supabase/server";
import { canEditDraft } from "@/newquip/quote/workflow";
import { loadQuote } from "@/lib/newquip-quotes/quote-store";
import { readCin7Customer, searchSyncedCustomers, type CustomerHit } from "@/lib/newquip-customers/cin7-customer-read";
import { appendSnapshot, customerFeaturesAvailable, latestSnapshot, snapshotHistory } from "@/lib/newquip-quotes/customer-store";
import { buildCustomerSnapshot, currencyStatus, diffSnapshots, snapshotIssues, withChosenContact, type ContactChoice, type CurrencyStatus, type CustomerSnapshot } from "@/lib/newquip-quotes/customer-snapshot";

export interface CustomerActionResult<T> { ok: boolean; error?: string; data?: T }

export interface QuoteCustomerView {
  available: boolean;
  snapshot: CustomerSnapshot | null;
  snapshotId: string | null;
  seq: number | null;
  issues: string[];
  currency: CurrencyStatus | null;
  editable: boolean;
  history: Array<{ seq: number; by: string; at: string; reason: string }>;
}

async function editableQuote(a: Actor, db: Db, quoteId: string) {
  if (!a.roles.has("rep")) throw new Error("Only a Rep can select the customer for a quotation.");
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (!canEditDraft(a.roles, q.state)) throw new Error(q.state === "MANAGER_APPROVED_FINAL" ? "The customer details of an approved quotation are immutable." : "You cannot change the customer on this quotation in its current state.");
  return q;
}

async function viewOf(db: Db, a: Actor, quoteId: string): Promise<QuoteCustomerView> {
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (!(await customerFeaturesAvailable(db))) return { available: false, snapshot: null, snapshotId: null, seq: null, issues: [], currency: null, editable: false, history: [] };
  const [s, hist] = await Promise.all([latestSnapshot(db, a.orgId, quoteId), snapshotHistory(db, a.orgId, quoteId)]);
  return {
    available: true, snapshot: s?.snapshot ?? null, snapshotId: s?.id ?? null, seq: s?.seq ?? null, issues: s ? snapshotIssues(s.snapshot) : ["Select the customer from Cin7."],
    currency: s ? currencyStatus(s.snapshot) : null, editable: a.roles.has("rep") && canEditDraft(a.roles, q.state),
    history: hist.map((h) => ({ seq: h.seq, by: h.captured_by_email, at: h.created_at, reason: h.reason })),
  };
}

export async function getQuoteCustomerAction(quoteId: string): Promise<CustomerActionResult<QuoteCustomerView>> {
  try {
    const a = await authoriseActor();
    return { ok: true, data: await viewOf(createServiceRoleClient(), a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Search the organisation's synced Cin7 customers by name, trading name, contact name or email. Cin7 Core has no customer code. */
export async function searchQuoteCustomersForQuoteAction(query: string): Promise<CustomerActionResult<CustomerHit[]>> {
  try {
    const a = await authoriseActor();
    if (!a.roles.has("rep")) throw new Error("Only a Rep can search customers for a quotation.");
    return { ok: true, data: await searchSyncedCustomers(createServiceRoleClient(), a.orgId, query) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Selects the Cin7 customer (by exact name) for the quotation: reads Cin7 (GET only) and appends an immutable snapshot. The Rep then chooses the contact. */
export async function selectQuoteCustomerAction(quoteId: string, customerName: string): Promise<CustomerActionResult<QuoteCustomerView>> {
  try {
    const a = await authoriseActor();
    const db = createServiceRoleClient();
    await editableQuote(a, db, quoteId);
    if (!(await customerFeaturesAvailable(db))) throw new Error("Customer snapshots are not available until the database update (migration 0115) is applied.");
    const raw = await readCin7Customer(db, a.orgId, customerName);
    if (!raw) throw new Error("That customer was not found in Cin7. Pick a customer from the search results.");
    const snap = buildCustomerSnapshot(raw, new Date().toISOString());
    const stored = await appendSnapshot(db, a.orgId, quoteId, snap, { email: a.email, ownerEmail: ownerEmailOf(a) }, "Customer selected from Cin7");
    await auditActor(db, a, { action: "newquip.quote_customer_selected", summary: "Selected the Cin7 customer for a NewQuip quotation (read-only; no Cin7 write)", detail: { quoteId, cin7CustomerId: stored.cin7_customer_id, seq: stored.seq } });
    return { ok: true, data: await viewOf(db, a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** The Rep chooses a Cin7 contact or enters the quotation contact / delivery email (validated, audited, never written to Cin7). */
export async function chooseQuoteContactAction(quoteId: string, choice: ContactChoice): Promise<CustomerActionResult<QuoteCustomerView>> {
  try {
    const a = await authoriseActor();
    const db = createServiceRoleClient();
    await editableQuote(a, db, quoteId);
    const cur = await latestSnapshot(db, a.orgId, quoteId);
    if (!cur) throw new Error("Select the customer first.");
    const next = withChosenContact(cur.snapshot, choice);
    await appendSnapshot(db, a.orgId, quoteId, next, { email: a.email, ownerEmail: ownerEmailOf(a) }, `Quotation contact set (${next.chosenContact?.source === "ENTERED" ? "entered by the Rep" : "Cin7 contact"})`);
    await auditActor(db, a, { action: "newquip.quote_contact_chosen", summary: "Set the quotation contact and delivery email (local only; Cin7 unchanged)", detail: { quoteId, source: next.chosenContact?.source, email: next.chosenContact?.email } });
    return { ok: true, data: await viewOf(db, a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

export interface RefreshPreview { changes: Array<{ field: string; before: string; after: string }>; applied: boolean }
/** Re-reads the customer from Cin7 for an EDITABLE quotation and shows which fields would change; `apply` stores the refreshed snapshot (the contact choice is kept when still valid). */
export async function refreshQuoteCustomerAction(quoteId: string, apply: boolean): Promise<CustomerActionResult<{ preview: RefreshPreview; view: QuoteCustomerView }>> {
  try {
    const a = await authoriseActor();
    const db = createServiceRoleClient();
    await editableQuote(a, db, quoteId);
    const cur = await latestSnapshot(db, a.orgId, quoteId);
    const name = cur?.snapshot.name.state === "present" ? cur.snapshot.name.value : null;
    if (!cur || !name) throw new Error("Select the customer first.");
    const raw = await readCin7Customer(db, a.orgId, name);
    if (!raw) throw new Error("The customer can no longer be found in Cin7 under that name.");
    const fresh = buildCustomerSnapshot(raw, new Date().toISOString());
    if (fresh.cin7CustomerId !== cur.snapshot.cin7CustomerId) throw new Error("The Cin7 customer behind that name has changed. Select the customer again.");
    const changes = diffSnapshots(cur.snapshot, fresh);
    let applied = false;
    if (apply && changes.length > 0) {
      const keep = cur.snapshot.chosenContact;
      const stillThere = keep && (keep.source === "ENTERED" || fresh.contacts.some((c) => c.email.state === "present" && c.email.value.toLowerCase() === keep.email.toLowerCase()));
      await appendSnapshot(db, a.orgId, quoteId, { ...fresh, chosenContact: stillThere ? keep : null }, { email: a.email, ownerEmail: ownerEmailOf(a) }, "Refreshed from Cin7");
      await auditActor(db, a, { action: "newquip.quote_customer_refreshed", summary: "Refreshed the customer snapshot from Cin7 (read-only; no Cin7 write)", detail: { quoteId, changes: changes.map((c) => c.field) } });
      applied = true;
    }
    return { ok: true, data: { preview: { changes, applied }, view: await viewOf(db, a, quoteId) } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

