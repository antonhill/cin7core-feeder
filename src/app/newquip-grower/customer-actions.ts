"use server";

// NewQuip: Cin7 customer lookup, quotation contact selection and the immutable customer snapshot. Cin7 stays the customer master: the only Cin7 call is a GET of /customer
// (never a create/update/delete), and nothing is written back. Re-authorised inside EVERY action: the NewQuip org check, then the Rep role (the effective Demo user when
// Demo Mode is on). A quotation of another organisation is indistinguishable from "not found". Only async functions and erased types are exported.
import { authoriseActor, auditActor, errText, ownerEmailOf, type Actor, type Db } from "./actor";
import { assertCustomerSelectable, guardQuote, quoteScope } from "@/lib/newquip-assignments/access";
import { assignedCustomers } from "@/lib/newquip-assignments/visibility";
import { createServiceRoleClient } from "@/supabase/server";
import { canEditDraft } from "@/newquip/quote/workflow";
import { applyCustomerChange, loadQuote } from "@/lib/newquip-quotes/quote-store";
import { readCin7Customer, searchSyncedCustomers, type CustomerHit } from "@/lib/newquip-customers/cin7-customer-read";
import { appendClearMarker, appendSnapshot, customerFeaturesAvailable, latestSnapshot, isClearedRow, snapshotHistory } from "@/lib/newquip-quotes/customer-store";
import { buildCustomerSnapshot, currencyStatus, describeContact, diffSnapshots, sameContact, selectedContactIndex, snapshotIssues, withChosenContact, type ContactChoice, type CurrencyStatus, type CustomerSnapshot } from "@/lib/newquip-quotes/customer-snapshot";

export interface CustomerActionResult<T> { ok: boolean; error?: string; data?: T }

export interface QuoteCustomerView {
  available: boolean;
  snapshot: CustomerSnapshot | null;
  snapshotId: string | null;
  seq: number | null;
  issues: string[];
  currency: CurrencyStatus | null;
  /** Index (in snapshot.contacts) of the chosen Cin7 contact, so the UI can highlight it; null for an entered contact or none. */
  selectedContactIndex: number | null;
  /** The recorded pre-approval confirmation contact (null until the Rep sends to the Estimator). */
  confirmationContact: import("@/lib/newquip-quotes/confirmation-contact").ConfirmationContact | null;
  editable: boolean;
  /** Why the customer cannot be changed (approved/issued quotation, or the viewer is not a Rep); null while it can. */
  lockedReason: string | null;
  /** Changing or clearing the customer now would send the quotation back from estimator review to the Rep (the customer's confirmed amount no longer applies). */
  changeReturnsToRep: boolean;
  history: Array<{ seq: number; by: string; at: string; reason: string; cleared: boolean }>;
}

async function editableQuote(a: Actor, db: Db, quoteId: string) {
  if (!a.roles.has("rep")) throw new Error("Only a Rep can select the customer for a quotation.");
  await guardQuote(db, a, quoteId);   // Rep isolation: the generic "Quote not found." before anything is read
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (!canEditDraft(a.roles, q.state)) throw new Error(q.state === "MANAGER_APPROVED_FINAL" ? "The customer details of an approved quotation are immutable." : "You cannot change the customer on this quotation in its current state.");
  return q;
}

async function viewOf(db: Db, a: Actor, quoteId: string): Promise<QuoteCustomerView> {
  await guardQuote(db, a, quoteId);
  const q = await loadQuote(db, a.orgId, quoteId);
  if (!q) throw new Error("Quote not found.");
  if (!(await customerFeaturesAvailable(db))) return { available: false, snapshot: null, snapshotId: null, seq: null, issues: [], currency: null, editable: false, lockedReason: null, changeReturnsToRep: false, selectedContactIndex: null, confirmationContact: null, history: [] };
  const [s, hist] = await Promise.all([latestSnapshot(db, a.orgId, quoteId), snapshotHistory(db, a.orgId, quoteId)]);
  // confirmationContact is exposed only while a pre-approval confirmation is actually on the quotation
  return {
    available: true, snapshot: s?.snapshot ?? null, snapshotId: s?.id ?? null, seq: s?.seq ?? null, issues: s ? snapshotIssues(s.snapshot) : ["Select the customer from Cin7."],
    currency: s ? currencyStatus(s.snapshot) : null, selectedContactIndex: s ? selectedContactIndex(s.snapshot) : null, confirmationContact: q.customer_confirmed_cents != null ? s?.snapshot.confirmationContact ?? null : null, editable: a.roles.has("rep") && canEditDraft(a.roles, q.state),
    lockedReason: q.state === "MANAGER_APPROVED_FINAL" ? "This quotation is approved, so its customer cannot be changed. Start a new quotation (or a variation) for a different customer." : !a.roles.has("rep") ? "Only a Rep can change the customer." : null,
    changeReturnsToRep: q.state === "ESTIMATOR_REVIEW",
    history: hist.map((h) => ({ seq: h.seq, by: h.captured_by_email, at: h.created_at, reason: h.reason, cleared: isClearedRow(h) })),
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
    const db = createServiceRoleClient();
    const scope = await quoteScope(db, a);
    if (scope.kind === "ORG_WIDE") return { ok: true, data: await searchSyncedCustomers(db, a.orgId, query) };
    // Rep isolation: an assigned-scoped Rep can only find (and so start a quotation for) the customers assigned to them.
    const term = String(query ?? "").trim().toLowerCase();
    if (term.length < 2) return { ok: true, data: [] };
    const mine = await assignedCustomers(db, a.orgId, a.userId);
    return { ok: true, data: mine.filter((c) => c.customer_name.toLowerCase().includes(term)).slice(0, 20).map((c) => ({ name: c.customer_name, tradingName: null, contactName: null, email: null, phone: null, currency: null })) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/**
 * Selects the Cin7 customer (by exact name) for the quotation: reads Cin7 (GET only) and appends an immutable snapshot. The Rep then chooses the contact.
 * REPLACING an already selected, different customer needs `confirmReplace` (enforced here, not just in the dialog): the new snapshot carries no contact from the old
 * customer, earlier snapshots are kept, and anything given for the previous customer (estimator sign-off, the customer's confirmed amount) is withdrawn.
 */
export async function selectQuoteCustomerAction(quoteId: string, customerName: string, confirmReplace = false): Promise<CustomerActionResult<QuoteCustomerView>> {
  try {
    const a = await authoriseActor();
    const db = createServiceRoleClient();
    await editableQuote(a, db, quoteId);
    if (!(await customerFeaturesAvailable(db))) throw new Error("Customer snapshots are not available until the database update (migration 0115) is applied.");
    const raw = await readCin7Customer(db, a.orgId, customerName);
    if (!raw) throw new Error("That customer was not found in Cin7. Pick a customer from the search results.");
    const snap = buildCustomerSnapshot(raw, new Date().toISOString());
    await assertCustomerSelectable(db, await quoteScope(db, a), snap.cin7CustomerId);   // Rep isolation: only an assigned customer may be selected
    const cur = await latestSnapshot(db, a.orgId, quoteId);
    if (cur && cur.snapshot.cin7CustomerId === snap.cin7CustomerId) return { ok: true, data: await viewOf(db, a, quoteId) }; // same customer: nothing to replace
    if (cur && !confirmReplace) throw new Error("Confirm that you want to replace the current customer on this quotation.");
    const from = cur ? (cur.snapshot.name.state === "present" ? cur.snapshot.name.value : cur.cin7_customer_id) : null;
    const to = snap.name.state === "present" ? snap.name.value : customerName;
    const who = { email: a.email, ownerEmail: ownerEmailOf(a) };
    const stored = await appendSnapshot(db, a.orgId, quoteId, snap, who, from ? `Customer changed from ${from} to ${to}` : "Customer selected from Cin7");
    const effect = await applyCustomerChange(db, a.orgId, quoteId, to, cur != null);
    await auditActor(db, a, cur
      ? { action: "newquip.quote_customer_changed", summary: "Replaced the Cin7 customer on a NewQuip quotation (read-only; no Cin7 write)", detail: { quoteId, fromCin7CustomerId: cur.cin7_customer_id, toCin7CustomerId: stored.cin7_customer_id, seq: stored.seq, ...effect } }
      : { action: "newquip.quote_customer_selected", summary: "Selected the Cin7 customer for a NewQuip quotation (read-only; no Cin7 write)", detail: { quoteId, cin7CustomerId: stored.cin7_customer_id, seq: stored.seq, ...effect } });
    return { ok: true, data: await viewOf(db, a, quoteId) };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

/** Clears the customer selection of an EDITABLE quotation: appends a "cleared" marker (history kept), blanks the customer name, withdraws sign-off / confirmation. Needs `confirm`. */
export async function clearQuoteCustomerAction(quoteId: string, confirm: boolean): Promise<CustomerActionResult<QuoteCustomerView>> {
  try {
    const a = await authoriseActor();
    const db = createServiceRoleClient();
    await editableQuote(a, db, quoteId);
    const cur = await latestSnapshot(db, a.orgId, quoteId);
    if (!cur) throw new Error("No customer is selected on this quotation.");
    if (!confirm) throw new Error("Confirm that you want to clear the customer on this quotation.");
    const from = cur.snapshot.name.state === "present" ? cur.snapshot.name.value : cur.cin7_customer_id;
    const marker = await appendClearMarker(db, a.orgId, quoteId, { email: a.email, ownerEmail: ownerEmailOf(a) }, `Customer cleared (was ${from})`);
    const effect = await applyCustomerChange(db, a.orgId, quoteId, "", true);
    await auditActor(db, a, { action: "newquip.quote_customer_cleared", summary: "Cleared the customer on a NewQuip quotation (local only; Cin7 unchanged)", detail: { quoteId, fromCin7CustomerId: cur.cin7_customer_id, seq: marker.seq, ...effect } });
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
    if (sameContact(cur.snapshot.chosenContact, next.chosenContact)) return { ok: true, data: await viewOf(db, a, quoteId) }; // already the quotation contact: no duplicate history row
    const prev = cur.snapshot.chosenContact;
    const how = next.chosenContact?.source === "ENTERED" ? "entered by the Rep" : next.chosenContact?.emailCorrection ? `Cin7 contact, email corrected for this quotation: ${next.chosenContact.emailCorrection.reason}` : "Cin7 contact";
    await appendSnapshot(db, a.orgId, quoteId, next, { email: a.email, ownerEmail: ownerEmailOf(a) }, `Quotation contact ${prev ? "changed" : "set"}: ${prev ? `${describeContact(prev)} → ` : ""}${describeContact(next.chosenContact)} (${how})`);
    await auditActor(db, a, { action: "newquip.quote_contact_chosen", summary: "Set the quotation contact and delivery email (local only; Cin7 unchanged)", detail: { quoteId, source: next.chosenContact?.source, email: next.chosenContact?.email, previousContact: prev ? { name: prev.name, email: prev.email } : null, ...(next.chosenContact?.emailCorrection ? { cin7Email: next.chosenContact.emailCorrection.cin7Email, correctionReason: next.chosenContact.emailCorrection.reason } : {}) } });
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
      const stillThere = keep && (keep.source === "ENTERED" || keep.emailCorrection != null || fresh.contacts.some((c) => c.email.state === "present" && c.email.value.toLowerCase() === keep.email.toLowerCase()));
      await appendSnapshot(db, a.orgId, quoteId, { ...fresh, chosenContact: stillThere ? keep : null, confirmationContact: cur.snapshot.confirmationContact ?? null }, { email: a.email, ownerEmail: ownerEmailOf(a) }, "Refreshed from Cin7");
      await auditActor(db, a, { action: "newquip.quote_customer_refreshed", summary: "Refreshed the customer snapshot from Cin7 (read-only; no Cin7 write)", detail: { quoteId, changes: changes.map((c) => c.field) } });
      applied = true;
    }
    return { ok: true, data: { preview: { changes, applied }, view: await viewOf(db, a, quoteId) } };
  } catch (e) { return { ok: false, error: errText(e) }; }
}

