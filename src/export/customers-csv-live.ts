import { toCsv } from "@/export/csv-format";

/**
 * Full Customers CSV template header, matching Cin7's own export exactly
 * (mirrors model/customers.ts's customerCsvRowSchema column order) — meant to
 * feed straight into runImport, same round-trip role as products-csv-live.ts.
 */
const HEADER = [
  "Name", "Status", "Currency", "PaymentTerm", "TaxRule", "AccountReceivable", "SaleAccount", "PriceTier",
  "Discount", "CreditLimit", "Carrier", "SalesRepresentative", "Location", "TaxNumber", "Tags", "DisplayName",
  "IsLegalEntity", "ParentCustomer", "IsBillParent", "AttributeSet",
  "AdditionalAttribute1", "AdditionalAttribute2", "AdditionalAttribute3", "AdditionalAttribute4", "AdditionalAttribute5",
  "AdditionalAttribute6", "AdditionalAttribute7", "AdditionalAttribute8", "AdditionalAttribute9", "AdditionalAttribute10",
  "Comments", "ContactName", "JobTitle", "Phone", "MobilePhone", "Fax", "Email", "Website", "ContactComment",
  "ContactDefault", "ContactIncludeInEmail", "MarketingConsent", "IsAccountingDimensionEnabled",
  "DimensionAttribute1", "DimensionAttribute2", "DimensionAttribute3", "DimensionAttribute4", "DimensionAttribute5",
  "DimensionAttribute6", "DimensionAttribute7", "DimensionAttribute8", "DimensionAttribute9", "DimensionAttribute10",
];

/** Cin7's own Customers/Suppliers CSV convention is "True"/"False" text, distinct from Products' "Yes"/"No" (see model/csv-helpers.ts's parseTrueFalse). */
function trueFalse(value: unknown): string {
  return value ? "True" : "False";
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

interface LiveContact {
  Name?: string;
  JobTitle?: string;
  Phone?: string;
  MobilePhone?: string;
  Fax?: string;
  Email?: string;
  Website?: string;
  Comment?: string;
  Default?: boolean;
  IncludeInEmail?: boolean;
}

const BLANK_CONTACT: LiveContact = {};

/**
 * Maps one raw Cin7 GET /customer record (see fetchAllCustomers) to one or
 * more Customers CSV rows — a customer with N contacts fans out to N rows
 * (same shared customer fields, one contact each), matching how the CSV
 * template itself represents multiple contacts per Name (see
 * model/customers.ts's CanonicalCustomerContact doc comment). A customer
 * with zero contacts still emits one row with blank contact fields, so it
 * isn't dropped entirely.
 *
 * `ParentCustomer` and `MarketingConsent` are left blank — Cin7's live
 * response doesn't confirm a `CustomerParentID`-to-name resolution or a
 * MarketingConsent integer-to-CSV-text mapping (see docs/cin7-api-findings.md
 * §10 and cin7/customers.ts's toCin7CustomerPayload comment) — same
 * capture-only fields as the push side, just in reverse.
 */
function toRows(c: Record<string, unknown>): (string | number)[][] {
  const contacts = (c.Contacts as LiveContact[] | undefined) ?? [];
  const rows = contacts.length ? contacts : [BLANK_CONTACT];

  return rows.map((contact) => [
    str(c.Name), str(c.Status), str(c.Currency), str(c.PaymentTerm), str(c.TaxRule),
    str(c.AccountReceivable), str(c.RevenueAccount), str(c.PriceTier),
    str(c.Discount ?? 0), str(c.CreditLimit ?? 0), str(c.Carrier), str(c.SalesRepresentative),
    str(c.Location), str(c.TaxNumber), str(c.Tags), str(c.DisplayName),
    trueFalse(c.IsLegalEntity), "", trueFalse(c.IsBillParent), str(c.AttributeSet),
    str(c.AdditionalAttribute1), str(c.AdditionalAttribute2), str(c.AdditionalAttribute3),
    str(c.AdditionalAttribute4), str(c.AdditionalAttribute5), str(c.AdditionalAttribute6),
    str(c.AdditionalAttribute7), str(c.AdditionalAttribute8), str(c.AdditionalAttribute9), str(c.AdditionalAttribute10),
    str(c.Comments),
    str(contact.Name), str(contact.JobTitle), str(contact.Phone), str(contact.MobilePhone),
    str(contact.Fax), str(contact.Email), str(contact.Website), str(contact.Comment),
    trueFalse(contact.Default), trueFalse(contact.IncludeInEmail),
    "", "",
    "", "", "", "", "", "", "", "", "", "",
  ]);
}

/** Full-fidelity export of every customer currently live in a chosen Cin7 instance, ready for runImport. */
export function toFullCustomersCsv(customers: Record<string, unknown>[]): string {
  return toCsv([HEADER, ...customers.flatMap(toRows)]);
}
