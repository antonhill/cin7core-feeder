import { z } from "zod";
import { commaNumber, parseTrueFalse } from "@/model/csv-helpers";

/** Mirrors every column of Cin7 Core's "Suppliers" CSV export template. */
export const supplierCsvRowSchema = z.object({
  Name: z.string().trim().min(1, "Name is required"),
  Status: z.string().trim().optional().default(""),
  Currency: z.string().trim().optional().default(""),
  PaymentTerm: z.string().trim().optional().default(""),
  TaxRule: z.string().trim().optional().default(""),
  AccountPayable: z.string().trim().optional().default(""),
  Carrier: z.string().trim().optional().default(""),
  Discount: commaNumber,
  TaxNumber: z.string().trim().optional().default(""),
  AttributeSet: z.string().trim().optional().default(""),
  AdditionalAttribute1: z.string().trim().optional().default(""),
  AdditionalAttribute2: z.string().trim().optional().default(""),
  AdditionalAttribute3: z.string().trim().optional().default(""),
  AdditionalAttribute4: z.string().trim().optional().default(""),
  AdditionalAttribute5: z.string().trim().optional().default(""),
  AdditionalAttribute6: z.string().trim().optional().default(""),
  AdditionalAttribute7: z.string().trim().optional().default(""),
  AdditionalAttribute8: z.string().trim().optional().default(""),
  AdditionalAttribute9: z.string().trim().optional().default(""),
  AdditionalAttribute10: z.string().trim().optional().default(""),
  Comments: z.string().trim().optional().default(""),
  ContactName: z.string().trim().optional().default(""),
  JobTitle: z.string().trim().optional().default(""),
  Phone: z.string().trim().optional().default(""),
  MobilePhone: z.string().trim().optional().default(""),
  Fax: z.string().trim().optional().default(""),
  Email: z.string().trim().optional().default(""),
  Website: z.string().trim().optional().default(""),
  ContactComment: z.string().trim().optional().default(""),
  ContactDefault: z.string().trim().optional().default(""),
  ContactIncludeInEmail: z.string().trim().optional().default(""),
  IsAccountingDimensionEnabled: z.string().trim().optional().default(""),
  DimensionAttribute1: z.string().trim().optional().default(""),
  DimensionAttribute2: z.string().trim().optional().default(""),
  DimensionAttribute3: z.string().trim().optional().default(""),
  DimensionAttribute4: z.string().trim().optional().default(""),
  DimensionAttribute5: z.string().trim().optional().default(""),
  DimensionAttribute6: z.string().trim().optional().default(""),
  DimensionAttribute7: z.string().trim().optional().default(""),
  DimensionAttribute8: z.string().trim().optional().default(""),
  DimensionAttribute9: z.string().trim().optional().default(""),
  DimensionAttribute10: z.string().trim().optional().default(""),
});

export type SupplierCsvRow = z.infer<typeof supplierCsvRowSchema>;

export interface CanonicalSupplier {
  name: string;
  status: string | null;
  currency: string | null;
  payment_term: string | null;
  tax_rule: string | null;
  account_payable: string | null;
  carrier: string | null;
  discount: number | null;
  tax_number: string | null;
  attribute_set: string | null;
  additional_attribute_1: string | null;
  additional_attribute_2: string | null;
  additional_attribute_3: string | null;
  additional_attribute_4: string | null;
  additional_attribute_5: string | null;
  additional_attribute_6: string | null;
  additional_attribute_7: string | null;
  additional_attribute_8: string | null;
  additional_attribute_9: string | null;
  additional_attribute_10: string | null;
  comments: string | null;
  is_accounting_dimension_enabled: boolean;
  dimension_attribute_1: string | null;
  dimension_attribute_2: string | null;
  dimension_attribute_3: string | null;
  dimension_attribute_4: string | null;
  dimension_attribute_5: string | null;
  dimension_attribute_6: string | null;
  dimension_attribute_7: string | null;
  dimension_attribute_8: string | null;
  dimension_attribute_9: string | null;
  dimension_attribute_10: string | null;
}

export function toCanonicalSupplier(row: SupplierCsvRow): CanonicalSupplier {
  return {
    name: row.Name,
    status: row.Status || null,
    currency: row.Currency || null,
    payment_term: row.PaymentTerm || null,
    tax_rule: row.TaxRule || null,
    account_payable: row.AccountPayable || null,
    carrier: row.Carrier || null,
    discount: row.Discount ?? null,
    tax_number: row.TaxNumber || null,
    attribute_set: row.AttributeSet || null,
    additional_attribute_1: row.AdditionalAttribute1 || null,
    additional_attribute_2: row.AdditionalAttribute2 || null,
    additional_attribute_3: row.AdditionalAttribute3 || null,
    additional_attribute_4: row.AdditionalAttribute4 || null,
    additional_attribute_5: row.AdditionalAttribute5 || null,
    additional_attribute_6: row.AdditionalAttribute6 || null,
    additional_attribute_7: row.AdditionalAttribute7 || null,
    additional_attribute_8: row.AdditionalAttribute8 || null,
    additional_attribute_9: row.AdditionalAttribute9 || null,
    additional_attribute_10: row.AdditionalAttribute10 || null,
    comments: row.Comments || null,
    is_accounting_dimension_enabled: parseTrueFalse(row.IsAccountingDimensionEnabled),
    dimension_attribute_1: row.DimensionAttribute1 || null,
    dimension_attribute_2: row.DimensionAttribute2 || null,
    dimension_attribute_3: row.DimensionAttribute3 || null,
    dimension_attribute_4: row.DimensionAttribute4 || null,
    dimension_attribute_5: row.DimensionAttribute5 || null,
    dimension_attribute_6: row.DimensionAttribute6 || null,
    dimension_attribute_7: row.DimensionAttribute7 || null,
    dimension_attribute_8: row.DimensionAttribute8 || null,
    dimension_attribute_9: row.DimensionAttribute9 || null,
    dimension_attribute_10: row.DimensionAttribute10 || null,
  };
}

/** A supplier Name can repeat across several CSV rows, one per contact — same reasoning as CanonicalCustomerContact. */
export interface CanonicalSupplierContact {
  name: string;
  contact_name: string | null;
  job_title: string | null;
  phone: string | null;
  mobile_phone: string | null;
  fax: string | null;
  email: string | null;
  website: string | null;
  contact_comment: string | null;
  contact_default: boolean;
  contact_include_in_email: boolean;
}

export function toCanonicalSupplierContact(row: SupplierCsvRow): CanonicalSupplierContact {
  return {
    name: row.Name,
    contact_name: row.ContactName || null,
    job_title: row.JobTitle || null,
    phone: row.Phone || null,
    mobile_phone: row.MobilePhone || null,
    fax: row.Fax || null,
    email: row.Email || null,
    website: row.Website || null,
    contact_comment: row.ContactComment || null,
    contact_default: parseTrueFalse(row.ContactDefault),
    contact_include_in_email: parseTrueFalse(row.ContactIncludeInEmail),
  };
}
