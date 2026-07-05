import { toCsv } from "@/export/csv-format";

/**
 * Full Suppliers CSV template header, matching model/suppliers.ts's
 * supplierCsvRowSchema column order — meant to feed straight into runImport,
 * same round-trip role as products-csv-live.ts.
 */
const HEADER = [
  "Name", "Status", "Currency", "PaymentTerm", "TaxRule", "AccountPayable", "Carrier", "Discount", "TaxNumber",
  "AttributeSet",
  "AdditionalAttribute1", "AdditionalAttribute2", "AdditionalAttribute3", "AdditionalAttribute4", "AdditionalAttribute5",
  "AdditionalAttribute6", "AdditionalAttribute7", "AdditionalAttribute8", "AdditionalAttribute9", "AdditionalAttribute10",
  "Comments", "ContactName", "JobTitle", "Phone", "MobilePhone", "Fax", "Email", "Website", "ContactComment",
  "ContactDefault", "ContactIncludeInEmail", "IsAccountingDimensionEnabled",
  "DimensionAttribute1", "DimensionAttribute2", "DimensionAttribute3", "DimensionAttribute4", "DimensionAttribute5",
  "DimensionAttribute6", "DimensionAttribute7", "DimensionAttribute8", "DimensionAttribute9", "DimensionAttribute10",
];

/** Cin7's own Customers/Suppliers CSV convention is "True"/"False" text (see model/csv-helpers.ts's parseTrueFalse). */
function trueFalse(value: unknown): string {
  return value ? "True" : "False";
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

interface LiveContact {
  Name?: string;
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
 * Maps one raw Cin7 GET /supplier record (see fetchAllSuppliers) to one or
 * more Suppliers CSV rows — same one-row-per-contact fan-out as
 * customers-csv-live.ts. `Carrier` and `JobTitle` are left blank — confirmed
 * absent from Cin7's real Supplier write model (see cin7/suppliers.ts's
 * toCin7SupplierPayload comment), so there's nothing to read back either.
 * `IsAccountingDimensionEnabled`/`DimensionAttribute*` aren't in Cin7's
 * model at all, same reasoning.
 */
function toRows(s: Record<string, unknown>): (string | number)[][] {
  const contacts = (s.Contacts as LiveContact[] | undefined) ?? [];
  const rows = contacts.length ? contacts : [BLANK_CONTACT];

  return rows.map((contact) => [
    str(s.Name), str(s.Status), str(s.Currency), str(s.PaymentTerm), str(s.TaxRule), str(s.AccountPayable),
    "", str(s.Discount ?? 0), str(s.TaxNumber),
    str(s.AttributeSet),
    str(s.AdditionalAttribute1), str(s.AdditionalAttribute2), str(s.AdditionalAttribute3),
    str(s.AdditionalAttribute4), str(s.AdditionalAttribute5), str(s.AdditionalAttribute6),
    str(s.AdditionalAttribute7), str(s.AdditionalAttribute8), str(s.AdditionalAttribute9), str(s.AdditionalAttribute10),
    str(s.Comments),
    str(contact.Name), "", str(contact.Phone), str(contact.MobilePhone),
    str(contact.Fax), str(contact.Email), str(contact.Website), str(contact.Comment),
    trueFalse(contact.Default), trueFalse(contact.IncludeInEmail),
    "",
    "", "", "", "", "", "", "", "", "", "",
  ]);
}

/** Full-fidelity export of every supplier currently live in a chosen Cin7 instance, ready for runImport. */
export function toFullSuppliersCsv(suppliers: Record<string, unknown>[]): string {
  return toCsv([HEADER, ...suppliers.flatMap(toRows)]);
}
