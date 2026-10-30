// NewQuip customer snapshot (pure; no I/O). Cin7 remains the authoritative customer master: the Cin7 customer ID is the reference, and this module only builds a
// quotation-specific, hash-sealed COPY of the commercial details used when a quotation is issued. Nothing here is ever written back to Cin7.
//
// Every field records whether Cin7 supplied it: "present" (a non-blank value), "empty" (Cin7 returned a blank string) or "missing" (absent from the record).
// A missing field is therefore never confused with an empty string, and a document is never silently completed with invented data.
//
// Cin7 Core has NO customer "code": a customer is identified by its Name and its ID (GUID) - see docs/cin7-api-findings.md section 10.
import { hashOf } from "@/newquip/quote/baseline";
import type { ConfirmationContact } from "./confirmation-contact";

export type Field = { state: "present"; value: string } | { state: "empty" } | { state: "missing" };

export interface SnapshotAddress {
  type: Field; line1: Field; line2: Field; city: Field; state: Field; postcode: Field; country: Field; defaultForType: boolean;
}
export interface SnapshotContact {
  name: Field; jobTitle: Field; email: Field; phone: Field; mobile: Field; isDefault: boolean; includeInEmail: boolean;
}
export interface ChosenContact {
  /** Where the quotation contact came from: one of Cin7's own contacts, or entered by the Rep (validated, audited, never written to Cin7). */
  source: "CIN7_CONTACT" | "ENTERED";
  name: string;
  email: string;
  phone: string | null;
  /** Set when the Rep corrected an invalid/missing Cin7 contact email FOR THIS QUOTATION ONLY: what Cin7 holds, and why it was corrected. Never written to Cin7. */
  emailCorrection?: { cin7Email: string | null; reason: string };
}
export interface CustomerSnapshot {
  schemaVersion: 1;
  cin7CustomerId: string;
  name: Field;
  tradingName: Field;
  currency: Field;
  paymentTerm: Field;
  vatNumber: Field;
  billingAddress: SnapshotAddress | null;
  contacts: SnapshotContact[];
  chosenContact: ChosenContact | null;
  /** The contact who gave the PRE-APPROVAL price confirmation (recorded when the Rep sends to the Estimator). Independent of chosenContact (the delivery contact). Absent until recorded. */
  confirmationContact?: ConfirmationContact | null;
  /** When this copy was read from Cin7 (ISO). */
  readAt: string;
}

const str = (v: unknown): Field => {
  if (v === undefined || v === null) return { state: "missing" };
  if (typeof v !== "string") return { state: "present", value: String(v) };
  return v.trim() === "" ? { state: "empty" } : { state: "present", value: v.trim() };
};
export const fieldValue = (f: Field): string | null => (f.state === "present" ? f.value : null);

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" ? (v as Record<string, unknown>) : {});

/** The billing address: the default Billing address, else the first Billing one. Never a shipping/business address presented as billing. */
function pickBilling(addresses: unknown): SnapshotAddress | null {
  const list = Array.isArray(addresses) ? addresses.map(rec) : [];
  const billing = list.filter((a) => String(a.Type ?? "").toLowerCase() === "billing");
  const a = billing.find((x) => x.DefaultForType === true) ?? billing[0];
  if (!a) return null;
  return { type: str(a.Type), line1: str(a.Line1), line2: str(a.Line2), city: str(a.City), state: str(a.State), postcode: str(a.Postcode), country: str(a.Country), defaultForType: a.DefaultForType === true };
}

const EMAIL = /^[^\s@,;<>()"']+@[^\s@,;<>()"']+\.[^\s@,;<>()"']{2,}$/;
export const isValidEmail = (e: string): boolean => e.length <= 254 && EMAIL.test(e.trim());

/** Builds the snapshot from ONE raw Cin7 customer record (GET /customer). Throws if the record has no ID: the ID is the authoritative reference. */
export function buildCustomerSnapshot(raw: Record<string, unknown>, readAt: string): CustomerSnapshot {
  const id = typeof raw.ID === "string" ? raw.ID.trim() : "";
  if (!id) throw new Error("The Cin7 customer record has no ID; it cannot be used as the authoritative reference.");
  const contacts: SnapshotContact[] = (Array.isArray(raw.Contacts) ? raw.Contacts : []).map(rec).map((c) => ({
    name: str(c.Name), jobTitle: str(c.JobTitle), email: str(c.Email), phone: str(c.Phone), mobile: str(c.MobilePhone), isDefault: c.Default === true, includeInEmail: c.IncludeInEmail === true,
  }));
  return {
    schemaVersion: 1, cin7CustomerId: id, name: str(raw.Name), tradingName: str(raw.DisplayName), currency: str(raw.Currency), paymentTerm: str(raw.PaymentTerm), vatNumber: str(raw.TaxNumber),
    billingAddress: pickBilling(raw.Addresses), contacts, chosenContact: null, readAt,
  };
}

export type ContactChoice = { source: "CIN7_CONTACT"; contactIndex: number; email?: string; correctionReason?: string } | { source: "ENTERED"; name: string; email: string; phone?: string };

/** Applies and validates the Rep's quotation contact choice. Returns a NEW snapshot (the input is not mutated). */
export function withChosenContact(s: CustomerSnapshot, choice: ContactChoice): CustomerSnapshot {
  if (choice.source === "ENTERED") {
    const name = choice.name.trim(); const email = choice.email.trim();
    if (name.length < 2 || name.length > 120) throw new Error("Enter the contact's name.");
    if (!isValidEmail(email)) throw new Error("Enter a valid email address for the quotation contact.");
    return { ...s, chosenContact: { source: "ENTERED", name, email, phone: choice.phone?.trim() ? choice.phone.trim() : null } };
  }
  const c = s.contacts[choice.contactIndex];
  if (!c) throw new Error("That contact is not on the Cin7 customer record.");
  const name = fieldValue(c.name);
  if (!name) throw new Error("That Cin7 contact has no name; enter the contact instead.");
  const cin7Email = fieldValue(c.email);
  const email = (choice.email ?? cin7Email ?? "").trim();
  if (!isValidEmail(email)) throw new Error(cin7Email ? "The contact's email address is not valid. Correct it for this quotation (Cin7 is not changed)." : "That Cin7 contact has no email address; enter one for this quotation.");
  const phone = fieldValue(c.phone) ?? fieldValue(c.mobile);
  if (cin7Email && email.toLowerCase() === cin7Email.toLowerCase()) return { ...s, chosenContact: { source: "CIN7_CONTACT", name, email, phone } };
  const reason = (choice.correctionReason ?? "").trim();
  if (reason.length < 5) throw new Error("Give a reason (at least 5 characters) for using a different email address than Cin7 holds. Cin7 is not changed.");
  return { ...s, chosenContact: { source: "CIN7_CONTACT", name, email, phone, emailCorrection: { cin7Email, reason } } };
}

/** Which of the snapshot's Cin7 contacts is the chosen quotation contact (by name + the email Cin7 holds, or the corrected one); null for an entered contact or none. */
export function selectedContactIndex(s: CustomerSnapshot): number | null {
  const c = s.chosenContact;
  if (!c || c.source !== "CIN7_CONTACT") return null;
  const cin7 = (c.emailCorrection ? c.emailCorrection.cin7Email : c.email)?.toLowerCase() ?? null;
  const i = s.contacts.findIndex((x) => fieldValue(x.name) === c.name && (fieldValue(x.email)?.toLowerCase() ?? null) === cin7);
  return i >= 0 ? i : null;
}
/** Short human label of the chosen contact, for history and audit ("Anton Hill <anton@x>"). */
export const describeContact = (c: ChosenContact | null): string => (c ? `${c.name} <${c.email}>` : "none");
/** True when two choices are the same contact and email (so re-clicking it is a no-op, not a new history row). */
export const sameContact = (a: ChosenContact | null, b: ChosenContact | null): boolean =>
  !!a && !!b && a.source === b.source && a.name === b.name && a.email.toLowerCase() === b.email.toLowerCase() && (a.phone ?? null) === (b.phone ?? null)
  && (a.emailCorrection?.reason ?? null) === (b.emailCorrection?.reason ?? null);

export type CurrencyStatus = { status: "ZAR" } | { status: "MISSING"; message: string } | { status: "INCOMPATIBLE"; currency: string; message: string };
/** POC rule: customer-facing NewQuip quotations are ZAR only. A different currency is rejected, never converted; an absent one is flagged. */
export function currencyStatus(s: CustomerSnapshot): CurrencyStatus {
  const c = fieldValue(s.currency);
  if (!c) return { status: "MISSING", message: "Cin7 holds no currency for this customer; the quotation is in ZAR." };
  if (c.toUpperCase() === "ZAR") return { status: "ZAR" };
  return { status: "INCOMPATIBLE", currency: c, message: `This customer is set up in ${c}. NewQuip customer quotations are ZAR only in this POC, so a quotation cannot be issued to them.` };
}

/** What is still missing before a customer document can be issued. Empty when nothing blocks. */
export function snapshotIssues(s: CustomerSnapshot): string[] {
  const out: string[] = [];
  if (!fieldValue(s.name)) out.push("The customer has no name in Cin7.");
  if (!s.billingAddress || !fieldValue(s.billingAddress.line1)) out.push("The customer has no billing address in Cin7.");
  if (!s.chosenContact) out.push("Choose the quotation contact and delivery email.");
  const cur = currencyStatus(s);
  if (cur.status === "INCOMPATIBLE") out.push(cur.message);
  return out;
}

export const snapshotHash = (s: CustomerSnapshot): string => hashOf(s);

const flat = (s: CustomerSnapshot): Record<string, string> => {
  const f = (x: Field) => (x.state === "present" ? x.value : x.state === "empty" ? "(empty)" : "(missing)");
  const a = s.billingAddress;
  const o: Record<string, string> = {
    "Customer name": f(s.name), "Trading name": f(s.tradingName), "Currency": f(s.currency), "Payment terms": f(s.paymentTerm), "VAT number": f(s.vatNumber),
    "Billing address": a ? [a.line1, a.line2, a.city, a.state, a.postcode, a.country].map(f).join(", ") : "(missing)",
  };
  s.contacts.forEach((c, i) => { o[`Cin7 contact ${i + 1}`] = `${f(c.name)} <${f(c.email)}>`; });
  return o;
};
/** Which Cin7-sourced fields differ between the stored snapshot and a fresh read (the quotation contact the Rep chose is not part of the comparison). */
export function diffSnapshots(before: CustomerSnapshot, after: CustomerSnapshot): { field: string; before: string; after: string }[] {
  const a = flat(before); const b = flat(after);
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => (a[k] ?? "(none)") !== (b[k] ?? "(none)")).map((k) => ({ field: k, before: a[k] ?? "(none)", after: b[k] ?? "(none)" }));
}
