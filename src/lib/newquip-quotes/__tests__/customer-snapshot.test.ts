import { describe, expect, it } from "vitest";
import { buildCustomerSnapshot, currencyStatus, diffSnapshots, isValidEmail, snapshotHash, snapshotIssues, withChosenContact } from "../customer-snapshot";

const RAW = {
  ID: "cin7-guid-1", Name: "Boerdery (Pty) Ltd", DisplayName: "Boerdery", Currency: "ZAR", PaymentTerm: "30 days", TaxNumber: "4123456789",
  Addresses: [
    { Type: "Shipping", Line1: "Farm gate", City: "Paarl", DefaultForType: true },
    { Type: "Billing", Line1: "PO Box 1", Line2: "", City: "Paarl", State: "WC", Postcode: "7646", Country: "South Africa", DefaultForType: true },
  ],
  Contacts: [
    { Name: "Piet", JobTitle: "Owner", Email: "piet@boerdery.co.za", Phone: "021 555", Default: true, IncludeInEmail: true },
    { Name: "Sarie", Email: "", MobilePhone: "082 555" },
  ],
};
const at = "2026-10-29T10:00:00.000Z";

describe("customer snapshot", () => {
  it("captures the Cin7 ID, billing address (never the shipping one), contacts and commercial fields", () => {
    const s = buildCustomerSnapshot(RAW, at);
    expect(s.cin7CustomerId).toBe("cin7-guid-1");
    expect(s.name).toEqual({ state: "present", value: "Boerdery (Pty) Ltd" });
    expect(s.billingAddress?.line1).toEqual({ state: "present", value: "PO Box 1" });
    expect(s.billingAddress?.city).toEqual({ state: "present", value: "Paarl" });
    expect(s.contacts).toHaveLength(2);
    expect(s.vatNumber).toEqual({ state: "present", value: "4123456789" });
  });
  it("distinguishes a missing field from an empty string", () => {
    const s = buildCustomerSnapshot(RAW, at);
    expect(s.billingAddress?.line2).toEqual({ state: "empty" });
    expect(s.billingAddress?.state).toEqual({ state: "present", value: "WC" });
    expect(s.contacts[1].email).toEqual({ state: "empty" });
    expect(s.contacts[1].jobTitle).toEqual({ state: "missing" });
  });
  it("refuses a record without a Cin7 ID (the ID is the authoritative reference)", () => {
    expect(() => buildCustomerSnapshot({ Name: "X" }, at)).toThrow(/no ID/);
    expect(() => buildCustomerSnapshot({ ID: "  ", Name: "X" }, at)).toThrow(/no ID/);
  });
  it("a customer with no Billing address has none (a shipping address is not substituted)", () => {
    const s = buildCustomerSnapshot({ ...RAW, Addresses: [{ Type: "Shipping", Line1: "x" }] }, at);
    expect(s.billingAddress).toBeNull();
    expect(snapshotIssues(withChosenContact(s, { source: "ENTERED", name: "Piet", email: "p@x.co.za" }))).toContain("The customer has no billing address in Cin7.");
  });
  it("contact selection: multiple contacts, validated email, missing email must be entered, entered contact validated", () => {
    const s = buildCustomerSnapshot(RAW, at);
    const a = withChosenContact(s, { source: "CIN7_CONTACT", contactIndex: 0 });
    expect(a.chosenContact).toEqual({ source: "CIN7_CONTACT", name: "Piet", email: "piet@boerdery.co.za", phone: "021 555" });
    expect(() => withChosenContact(s, { source: "CIN7_CONTACT", contactIndex: 1 })).toThrow(/no email address/);
    // an email Cin7 does not hold (missing or invalid) needs an audited reason; it is used on the quotation only
    expect(() => withChosenContact(s, { source: "CIN7_CONTACT", contactIndex: 1, email: "sarie@boerdery.co.za" })).toThrow(/reason/);
    const b = withChosenContact(s, { source: "CIN7_CONTACT", contactIndex: 1, email: "sarie@boerdery.co.za", correctionReason: "no email in Cin7" });
    expect(b.chosenContact).toMatchObject({ name: "Sarie", email: "sarie@boerdery.co.za", phone: "082 555", emailCorrection: { cin7Email: null, reason: "no email in Cin7" } });
    expect(s.contacts[1].email.state).not.toBe("present"); // the snapshot's Cin7 data is not altered
    expect(() => withChosenContact(s, { source: "CIN7_CONTACT", contactIndex: 5 })).toThrow(/not on the Cin7/);
    expect(() => withChosenContact(s, { source: "ENTERED", name: "A", email: "a@b.co" })).toThrow(/name/);
    for (const bad of ["a@b", "a b@c.co", "a@b.co, c@d.co", "@b.co", "a@b.c", "<a@b.co>"]) expect(isValidEmail(bad), bad).toBe(false);
    expect(s.chosenContact).toBeNull(); // the input is never mutated
  });
  it("ZAR only: another currency is rejected and blocks issuing; an absent currency is flagged, not converted", () => {
    const usd = buildCustomerSnapshot({ ...RAW, Currency: "USD" }, at);
    expect(currencyStatus(usd)).toMatchObject({ status: "INCOMPATIBLE", currency: "USD" });
    expect(snapshotIssues(withChosenContact(usd, { source: "CIN7_CONTACT", contactIndex: 0 })).join(" ")).toMatch(/ZAR only/);
    expect(currencyStatus(buildCustomerSnapshot({ ...RAW, Currency: undefined }, at)).status).toBe("MISSING");
    expect(currencyStatus(buildCustomerSnapshot({ ...RAW, Currency: "zar" }, at)).status).toBe("ZAR");
  });
  it("hash is stable and any change to the snapshot changes it", () => {
    const s = buildCustomerSnapshot(RAW, at);
    expect(snapshotHash(s)).toBe(snapshotHash(buildCustomerSnapshot({ ...RAW }, at)));
    expect(snapshotHash(s)).not.toBe(snapshotHash(buildCustomerSnapshot({ ...RAW, Name: "Other" }, at)));
  });
  it("refresh diff lists exactly the changed Cin7 fields", () => {
    const a = buildCustomerSnapshot(RAW, at);
    const b = buildCustomerSnapshot({ ...RAW, TaxNumber: "999", Addresses: [{ Type: "Billing", Line1: "New street", City: "Paarl", State: "WC", Postcode: "7646", Country: "South Africa", DefaultForType: true }] }, at);
    expect(diffSnapshots(a, b).map((d) => d.field).sort()).toEqual(["Billing address", "VAT number"]);
    expect(diffSnapshots(a, a)).toEqual([]);
  });
});

import { readFileSync } from "node:fs";
import path from "node:path";
describe("Cin7 customer master is never written", () => {
  const ROOT = path.resolve(__dirname, "../../../");
  const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
  it("the customer lookup / snapshot / actions only ever READ Cin7 (no write module, no mutating verb, no push)", () => {
    for (const rel of ["lib/newquip-customers/cin7-customer-read.ts", "lib/newquip-quotes/customer-store.ts", "lib/newquip-quotes/customer-snapshot.ts", "app/newquip-grower/customer-actions.ts"]) {
      const s = src(rel);
      expect(s, rel).not.toMatch(/pushCustomer|sale-quote-write|sale-order-write|purchase-write|method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']|\bfetch\s*\(/);
    }
    // the one Cin7 customer read added for this feature is a GET-only function: no method option, no body
    const fn = src("cin7/customers.ts").split("export async function fetchCustomerRecordByName")[1].split("\n}\n")[0];
    expect(fn).not.toMatch(/method|body/);
  });
});
