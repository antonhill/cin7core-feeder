// NewQuip pre-approval customer confirmation - validity (pure; no I/O). The confirmation is (a named contact + the confirmed amount ex VAT) recorded at handoff
// (newquip_quotes.customer_confirmed_* and snapshot.confirmationContact). It stops applying when the CONFIRMED CONTACT is no longer what the quotation says, or when the
// quotation total no longer equals the confirmed amount. This module only DECIDES; clearing is done by quote-store invalidateConfirmation. Usable by the UI and by actions.
import { fieldValue, type CustomerSnapshot } from "./customer-snapshot";

export type ConfirmationStatus = "none" | "valid" | "amount_changed" | "contact_changed";

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

/**
 * Whether the person who confirmed is still the person the quotation records.
 *  - QUOTATION_CONTACT: the confirmation FOLLOWS the quotation contact, so it holds only while the chosen contact (name + email, case-insensitive) is the same one.
 *  - CIN7_CONTACT: holds while that contact (name + email) is still on the Cin7 customer snapshot.
 *  - ALTERNATIVE: a recorded free-standing person; independent of the quotation contact, so it holds.
 * A different Cin7 customer always breaks it. `snap` null (customer snapshots unavailable) cannot contradict a confirmation.
 */
export function confirmedContactStillValid(snap: CustomerSnapshot | null | undefined): boolean {
  const c = snap?.confirmationContact;
  if (!snap || !c) return true;
  if (c.cin7CustomerId && snap.cin7CustomerId && c.cin7CustomerId !== snap.cin7CustomerId) return false;
  if (c.source === "ALTERNATIVE") return true;
  if (c.source === "QUOTATION_CONTACT") {
    const chosen = snap.chosenContact;
    return !!chosen && norm(chosen.name) === norm(c.name) && norm(chosen.email) === norm(c.email);
  }
  return snap.contacts.some((x) => norm(fieldValue(x.name)) === norm(c.name) && norm(fieldValue(x.email)) === norm(c.email));
}

/**
 * The state of the quotation's customer confirmation. `none`: nothing recorded. `amount_changed`: the current total (ex VAT, cents) differs from the confirmed amount,
 * or cannot be determined (fail closed). `contact_changed`: the confirmed contact no longer stands (see confirmedContactStillValid). Amount is checked first.
 */
export function confirmationStatus(
  quote: { customer_confirmed_cents: number | null; customer_confirmed_by?: string | null },
  currentTotalCents: number | null, snap?: CustomerSnapshot | null,
): ConfirmationStatus {
  if (quote.customer_confirmed_cents == null) return "none";
  if (currentTotalCents == null || currentTotalCents !== quote.customer_confirmed_cents) return "amount_changed";
  if (!confirmedContactStillValid(snap)) return "contact_changed";
  return "valid";
}

/** Plain-language reason a non-valid status blocks sign-off / approval; null when valid. */
export function confirmationBlockReason(s: ConfirmationStatus): string | null {
  if (s === "valid") return null;
  if (s === "none") return "The customer's confirmation was never recorded. Return it to the Rep to confirm the amount with the customer.";
  if (s === "amount_changed") return "The total changed since the customer confirmed it. Return it to the rep to reconfirm with the customer.";
  return "The contact who confirmed the amount no longer matches the quotation. Return it to the Rep to reconfirm with the customer.";
}
