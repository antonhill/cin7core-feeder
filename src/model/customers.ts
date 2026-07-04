import { z } from "zod";
import { commaNumber, parseTrueFalse } from "@/model/csv-helpers";

/** Mirrors every column of Cin7 Core's "Customers" CSV export template. */
export const customerCsvRowSchema = z.object({
  Name: z.string().trim().min(1, "Name is required"),
  Status: z.string().trim().optional().default(""),
  Currency: z.string().trim().optional().default(""),
  PaymentTerm: z.string().trim().optional().default(""),
  TaxRule: z.string().trim().optional().default(""),
  AccountReceivable: z.string().trim().optional().default(""),
  SaleAccount: z.string().trim().optional().default(""),
  PriceTier: z.string().trim().optional().default(""),
  Discount: commaNumber,
  CreditLimit: commaNumber,
  Carrier: z.string().trim().optional().default(""),
  SalesRepresentative: z.string().trim().optional().default(""),
  Location: z.string().trim().optional().default(""),
  TaxNumber: z.string().trim().optional().default(""),
  Tags: z.string().trim().optional().default(""),
  DisplayName: z.string().trim().optional().default(""),
  IsLegalEntity: z.string().trim().optional().default(""),
  ParentCustomer: z.string().trim().optional().default(""),
  IsBillParent: z.string().trim().optional().default(""),
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
  MarketingConsent: z.string().trim().optional().default(""),
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

export type CustomerCsvRow = z.infer<typeof customerCsvRowSchema>;

export interface CanonicalCustomer {
  name: string;
  status: string | null;
  currency: string | null;
  payment_term: string | null;
  tax_rule: string | null;
  account_receivable: string | null;
  sale_account: string | null;
  price_tier: string | null;
  discount: number | null;
  credit_limit: number | null;
  carrier: string | null;
  sales_representative: string | null;
  location: string | null;
  tax_number: string | null;
  tags: string | null;
  display_name: string | null;
  is_legal_entity: boolean;
  parent_customer: string | null;
  is_bill_parent: boolean;
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

export function toCanonicalCustomer(row: CustomerCsvRow): CanonicalCustomer {
  return {
    name: row.Name,
    status: row.Status || null,
    currency: row.Currency || null,
    payment_term: row.PaymentTerm || null,
    tax_rule: row.TaxRule || null,
    account_receivable: row.AccountReceivable || null,
    sale_account: row.SaleAccount || null,
    price_tier: row.PriceTier || null,
    discount: row.Discount ?? null,
    credit_limit: row.CreditLimit ?? null,
    carrier: row.Carrier || null,
    sales_representative: row.SalesRepresentative || null,
    location: row.Location || null,
    tax_number: row.TaxNumber || null,
    tags: row.Tags || null,
    display_name: row.DisplayName || null,
    is_legal_entity: parseTrueFalse(row.IsLegalEntity),
    parent_customer: row.ParentCustomer || null,
    is_bill_parent: parseTrueFalse(row.IsBillParent),
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

/**
 * A customer Name can repeat across several CSV rows, one per contact
 * (confirmed live — some customers have 10+ contact rows) — this is why
 * contacts are their own table, not columns on the customer row itself. See
 * migration 0015 and commit-customers.ts.
 */
export interface CanonicalCustomerContact {
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
  marketing_consent: string | null;
}

export function toCanonicalCustomerContact(row: CustomerCsvRow): CanonicalCustomerContact {
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
    marketing_consent: row.MarketingConsent || null,
  };
}
