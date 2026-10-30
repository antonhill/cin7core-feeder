// The customer contact who RESPONDED to an issued quotation (pure). Distinct from the quotation's delivery contact (who received it) and from the pre-approval
// confirmation contact. Resolved on the SERVER from the document's frozen customer snapshot; nothing here is ever written to Cin7.
import { fieldValue, isValidEmail, type CustomerSnapshot } from "./customer-snapshot";

export type ResponseContactInput =
  | { source: "DELIVERY_CONTACT" }
  | { source: "CIN7_CONTACT"; contactIndex: number }
  | { source: "ALTERNATIVE"; name: string; email?: string; reason: string };

export interface ResolvedResponseContact { source: "DELIVERY_CONTACT" | "CIN7_CONTACT" | "ALTERNATIVE"; name: string; email: string | null; exceptionReason: string | null }

/** `delivery` is the contact printed on / emailed the issued document. */
export function resolveResponseContact(snap: CustomerSnapshot | null, delivery: { name: string; email: string } | null, input: ResponseContactInput): ResolvedResponseContact {
  if (input.source === "ALTERNATIVE") {
    const name = (input.name ?? "").trim(); const reason = (input.reason ?? "").trim(); const email = (input.email ?? "").trim();
    if (name.length < 2 || name.length > 120) throw new Error("Enter the name of the person who responded.");
    if (reason.length < 5) throw new Error("Give a reason (at least 5 characters) for using a contact who is not on the customer record. Cin7 is not changed.");
    if (email && !isValidEmail(email)) throw new Error("The alternative contact's email address is not valid.");
    return { source: "ALTERNATIVE", name, email: email || null, exceptionReason: reason };
  }
  if (input.source === "DELIVERY_CONTACT") {
    if (!delivery) throw new Error("The contact who received the quotation is not on record; choose a customer contact or enter an alternative.");
    return { source: "DELIVERY_CONTACT", name: delivery.name, email: delivery.email, exceptionReason: null };
  }
  const c = snap?.contacts[input.contactIndex];
  const name = c ? fieldValue(c.name) : null;
  if (!c || !name) throw new Error("That contact is not on the customer's Cin7 record.");
  return { source: "CIN7_CONTACT", name, email: fieldValue(c.email), exceptionReason: null };
}
