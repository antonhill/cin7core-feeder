import type { SupabaseClient } from "@supabase/supabase-js";
import { toCsv } from "@/export/csv-format";

function boolStr(v: boolean): string {
  return v ? "True" : "False";
}

const HEADER = [
  "Name",
  "Status",
  "Currency",
  "PaymentTerm",
  "TaxRule",
  "AccountReceivable",
  "SaleAccount",
  "PriceTier",
  "Discount",
  "CreditLimit",
  "Carrier",
  "SalesRepresentative",
  "Location",
  "TaxNumber",
  "Tags",
  "DisplayName",
  "IsLegalEntity",
  "ParentCustomer",
  "IsBillParent",
  "AttributeSet",
  "AdditionalAttribute1",
  "AdditionalAttribute2",
  "AdditionalAttribute3",
  "AdditionalAttribute4",
  "AdditionalAttribute5",
  "AdditionalAttribute6",
  "AdditionalAttribute7",
  "AdditionalAttribute8",
  "AdditionalAttribute9",
  "AdditionalAttribute10",
  "Comments",
  "ContactName",
  "JobTitle",
  "Phone",
  "MobilePhone",
  "Fax",
  "Email",
  "Website",
  "ContactComment",
  "ContactDefault",
  "ContactIncludeInEmail",
  "MarketingConsent",
  "IsAccountingDimensionEnabled",
  "DimensionAttribute1",
  "DimensionAttribute2",
  "DimensionAttribute3",
  "DimensionAttribute4",
  "DimensionAttribute5",
  "DimensionAttribute6",
  "DimensionAttribute7",
  "DimensionAttribute8",
  "DimensionAttribute9",
  "DimensionAttribute10",
];

interface CustomerContact {
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

const EMPTY_CONTACT: CustomerContact = {
  contact_name: null,
  job_title: null,
  phone: null,
  mobile_phone: null,
  fax: null,
  email: null,
  website: null,
  contact_comment: null,
  contact_default: false,
  contact_include_in_email: false,
  marketing_consent: null,
};

/**
 * Exports the org's canonical customers in the same column format as Cin7's
 * Customers CSV template — one row per (customer, contact) pair, matching
 * how Cin7 itself exports a customer with several contacts as several rows
 * sharing the same Name (see migration 0015). A customer with no contacts
 * at all still gets exactly one row, with the contact columns blank.
 */
export async function exportCustomersCsv(db: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await db.from("customers").select("*").eq("org_id", orgId).order("name");
  if (error) throw new Error(`customers: ${error.message}`);

  const { data: contactRows, error: contactsError } = await db
    .from("customer_contacts")
    .select("name, contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email, marketing_consent")
    .eq("org_id", orgId);
  if (contactsError) throw new Error(`customer_contacts: ${contactsError.message}`);

  const contactsByName = new Map<string, CustomerContact[]>();
  for (const { name, ...contact } of contactRows ?? []) {
    const list = contactsByName.get(name) ?? [];
    list.push(contact);
    contactsByName.set(name, list);
  }

  const rows = (data ?? []).flatMap((c) => {
    const contacts = contactsByName.get(c.name) ?? [EMPTY_CONTACT];
    return contacts.map((contact) => [
      c.name,
      c.status ?? "",
      c.currency ?? "",
      c.payment_term ?? "",
      c.tax_rule ?? "",
      c.account_receivable ?? "",
      c.sale_account ?? "",
      c.price_tier ?? "",
      c.discount ?? "",
      c.credit_limit ?? "",
      c.carrier ?? "",
      c.sales_representative ?? "",
      c.location ?? "",
      c.tax_number ?? "",
      c.tags ?? "",
      c.display_name ?? "",
      boolStr(c.is_legal_entity),
      c.parent_customer ?? "",
      boolStr(c.is_bill_parent),
      c.attribute_set ?? "",
      c.additional_attribute_1 ?? "",
      c.additional_attribute_2 ?? "",
      c.additional_attribute_3 ?? "",
      c.additional_attribute_4 ?? "",
      c.additional_attribute_5 ?? "",
      c.additional_attribute_6 ?? "",
      c.additional_attribute_7 ?? "",
      c.additional_attribute_8 ?? "",
      c.additional_attribute_9 ?? "",
      c.additional_attribute_10 ?? "",
      c.comments ?? "",
      contact.contact_name ?? "",
      contact.job_title ?? "",
      contact.phone ?? "",
      contact.mobile_phone ?? "",
      contact.fax ?? "",
      contact.email ?? "",
      contact.website ?? "",
      contact.contact_comment ?? "",
      boolStr(contact.contact_default),
      boolStr(contact.contact_include_in_email),
      contact.marketing_consent ?? "",
      boolStr(c.is_accounting_dimension_enabled),
      c.dimension_attribute_1 ?? "",
      c.dimension_attribute_2 ?? "",
      c.dimension_attribute_3 ?? "",
      c.dimension_attribute_4 ?? "",
      c.dimension_attribute_5 ?? "",
      c.dimension_attribute_6 ?? "",
      c.dimension_attribute_7 ?? "",
      c.dimension_attribute_8 ?? "",
      c.dimension_attribute_9 ?? "",
      c.dimension_attribute_10 ?? "",
    ]);
  });

  return toCsv([HEADER, ...rows]);
}
