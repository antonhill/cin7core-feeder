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

/** Exports the org's canonical suppliers in the same column format as Cin7's Suppliers CSV template. */
export async function exportSuppliersCsv(db: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await db.from("suppliers").select("*").eq("org_id", orgId).order("name");
  if (error) throw new Error(`suppliers: ${error.message}`);

  const rows = (data ?? []).map((s) => [
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
    s.contact_name ?? "",
    s.job_title ?? "",
    s.phone ?? "",
    s.mobile_phone ?? "",
    s.fax ?? "",
    s.email ?? "",
    s.website ?? "",
    s.contact_comment ?? "",
    boolStr(s.contact_default),
    boolStr(s.contact_include_in_email),
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

  return toCsv([HEADER, ...rows]);
}
