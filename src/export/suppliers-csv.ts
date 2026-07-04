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
  "AccountPayable",
  "Carrier",
  "Discount",
  "TaxNumber",
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

interface SupplierContact {
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

const EMPTY_CONTACT: SupplierContact = {
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
};

/**
 * Exports the org's canonical suppliers in the same column format as Cin7's
 * Suppliers CSV template — one row per (supplier, contact) pair, same
 * reasoning as exportCustomersCsv.
 */
export async function exportSuppliersCsv(db: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await db.from("suppliers").select("*").eq("org_id", orgId).order("name");
  if (error) throw new Error(`suppliers: ${error.message}`);

  const { data: contactRows, error: contactsError } = await db
    .from("supplier_contacts")
    .select("name, contact_name, job_title, phone, mobile_phone, fax, email, website, contact_comment, contact_default, contact_include_in_email")
    .eq("org_id", orgId);
  if (contactsError) throw new Error(`supplier_contacts: ${contactsError.message}`);

  const contactsByName = new Map<string, SupplierContact[]>();
  for (const { name, ...contact } of contactRows ?? []) {
    const list = contactsByName.get(name) ?? [];
    list.push(contact);
    contactsByName.set(name, list);
  }

  const rows = (data ?? []).flatMap((s) => {
    const contacts = contactsByName.get(s.name) ?? [EMPTY_CONTACT];
    return contacts.map((contact) => [
      s.name,
      s.status ?? "",
      s.currency ?? "",
      s.payment_term ?? "",
      s.tax_rule ?? "",
      s.account_payable ?? "",
      s.carrier ?? "",
      s.discount ?? "",
      s.tax_number ?? "",
      s.attribute_set ?? "",
      s.additional_attribute_1 ?? "",
      s.additional_attribute_2 ?? "",
      s.additional_attribute_3 ?? "",
      s.additional_attribute_4 ?? "",
      s.additional_attribute_5 ?? "",
      s.additional_attribute_6 ?? "",
      s.additional_attribute_7 ?? "",
      s.additional_attribute_8 ?? "",
      s.additional_attribute_9 ?? "",
      s.additional_attribute_10 ?? "",
      s.comments ?? "",
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
      boolStr(s.is_accounting_dimension_enabled),
      s.dimension_attribute_1 ?? "",
      s.dimension_attribute_2 ?? "",
      s.dimension_attribute_3 ?? "",
      s.dimension_attribute_4 ?? "",
      s.dimension_attribute_5 ?? "",
      s.dimension_attribute_6 ?? "",
      s.dimension_attribute_7 ?? "",
      s.dimension_attribute_8 ?? "",
      s.dimension_attribute_9 ?? "",
      s.dimension_attribute_10 ?? "",
    ]);
  });

  return toCsv([HEADER, ...rows]);
}
