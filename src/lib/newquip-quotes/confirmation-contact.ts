// NewQuip PRE-APPROVAL price confirmation contact (pure; no I/O). Before the Estimator reviews, the Rep records that a customer contact confirmed the commercial amount
// (newquip_quotes.customer_confirmed_cents). That is NOT the customer's formal acceptance of the issued quotation (newquip_quote_responses, after Manager approval) and never
// satisfies that gate. The contact is resolved on the SERVER from the quotation's own Cin7 customer snapshot, never taken from the browser, and is independent of the
// quotation delivery contact (snapshot.chosenContact), which is not changed by it. Nothing here is written to Cin7.
import { fieldValue, isValidEmail, type CustomerSnapshot } from "./customer-snapshot";

export type ConfirmationInput =
  | { source: "QUOTATION_CONTACT" }
  | { source: "CIN7_CONTACT"; contactIndex: number }
  | { source: "ALTERNATIVE"; name: string; email?: string; reason: string };

export interface ConfirmationContact {
  source: "QUOTATION_CONTACT" | "CIN7_CONTACT" | "ALTERNATIVE";
  /** Where the person comes from, in words: "Cin7 contact", "Quotation-only contact (not in Cin7)", or "Alternative contact (not listed)". */
  origin: string;
  name: string;
  email: string | null;
  reason: string | null;
  customerName: string | null;
  cin7CustomerId: string | null;
  selectedBy: string;
  selectedAt: string;
  amountCents: number;
}

export interface ConfirmCtx { by: string; at: string; amountCents: number }

/** Text kept in newquip_quotes.customer_confirmed_by (shown in the workflow panel and approval review). */
export const confirmationLabel = (c: ConfirmationContact): string =>
  c.source === "ALTERNATIVE" ? `${c.name} (alternative contact: ${c.reason})` : c.email ? `${c.name} <${c.email}>` : c.name;

/** Resolves the confirmation contact. Throws a plain-language error when the choice is not valid. `snap` is null only where customer snapshots do not exist yet. */
export function resolveConfirmationContact(snap: CustomerSnapshot | null, input: ConfirmationInput, ctx: ConfirmCtx): ConfirmationContact {
  const base = { selectedBy: ctx.by, selectedAt: ctx.at, amountCents: ctx.amountCents, customerName: snap ? fieldValue(snap.name) : null, cin7CustomerId: snap?.cin7CustomerId ?? null };
  if (input.source === "ALTERNATIVE") {
    const name = (input.name ?? "").trim(); const reason = (input.reason ?? "").trim(); const email = (input.email ?? "").trim();
    if (name.length < 2 || name.length > 120) throw new Error("Enter the name of the person who confirmed the amount.");
    if (reason.length < 5) throw new Error("Give a reason (at least 5 characters) for using a contact who is not listed. Cin7 is not changed.");
    if (email && !isValidEmail(email)) throw new Error("The alternative contact's email address is not valid.");
    return { ...base, source: "ALTERNATIVE", origin: "Alternative contact (not listed)", name, email: email || null, reason };
  }
  if (!snap) throw new Error("Select the Cin7 customer in Step 1 (Customer & site) first, or record an alternative contact with a reason.");
  if (input.source === "QUOTATION_CONTACT") {
    const c = snap.chosenContact;
    if (!c) throw new Error("Choose the quotation contact in Step 1 (Customer & site), or pick a contact here.");
    return { ...base, source: "QUOTATION_CONTACT", origin: c.source === "ENTERED" || c.emailCorrection ? "Quotation-only contact (audited; not written to Cin7)" : "Cin7 contact", name: c.name, email: c.email, reason: null };
  }
  const c = snap.contacts[input.contactIndex];
  if (!c) throw new Error("That contact is not on the Cin7 customer record.");
  const name = fieldValue(c.name);
  if (!name) throw new Error("That Cin7 contact has no name; record an alternative contact instead.");
  return { ...base, source: "CIN7_CONTACT", origin: "Cin7 contact", name, email: fieldValue(c.email), reason: null };
}
