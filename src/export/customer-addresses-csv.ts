import type { SupabaseClient } from "@supabase/supabase-js";
import { toCsv } from "@/export/csv-format";

const HEADER = [
  "Action",
  "Name",
  "AddressType",
  "AddressDefaultForType",
  "AddressLine1",
  "AddressLine2",
  "City",
  "State",
  "Postcode",
  "Country",
  "IsParent",
];

/** Exports the org's canonical customer addresses in the same column format as Cin7's CustomerAddresses CSV template. */
export async function exportCustomerAddressesCsv(db: SupabaseClient, orgId: string): Promise<string> {
  const { data, error } = await db
    .from("customer_addresses")
    .select("name, address_type, address_default_for_type, address_line_1, address_line_2, city, state, postcode, country, is_parent")
    .eq("org_id", orgId)
    .order("name")
    .order("address_type");
  if (error) throw new Error(`customer_addresses: ${error.message}`);

  const rows = (data ?? []).map((a) => [
    "Create/Update",
    a.name,
    a.address_type,
    a.address_default_for_type ? "True" : "False",
    a.address_line_1 ?? "",
    a.address_line_2 ?? "",
    a.city ?? "",
    a.state ?? "",
    a.postcode ?? "",
    a.country ?? "",
    a.is_parent ? "True" : "False",
  ]);

  return toCsv([HEADER, ...rows]);
}
