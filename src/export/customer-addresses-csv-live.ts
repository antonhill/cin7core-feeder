import { toCsv } from "@/export/csv-format";

/** Full CustomerAddresses CSV template header, matching model/customer-addresses.ts's schema column order. */
const HEADER = [
  "Action", "Name", "AddressType", "AddressDefaultForType",
  "AddressLine1", "AddressLine2", "City", "State", "Postcode", "Country", "IsParent",
];

function trueFalse(value: unknown): string {
  return value ? "True" : "False";
}

function str(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

interface LiveAddress {
  Type?: string;
  DefaultForType?: boolean;
  Line1?: string;
  Line2?: string;
  City?: string;
  State?: string;
  Postcode?: string;
  Country?: string;
}

/**
 * Maps one raw Cin7 GET /customer record's nested Addresses[] (see
 * fetchAllCustomers, docs/cin7-api-findings.md §10) to CustomerAddresses CSV
 * rows — one row per address, "Action" fixed to "Create/Update" (the same
 * default the schema itself uses). `IsParent` has no confirmed equivalent on
 * the live Addresses[] shape — left blank rather than guessed.
 */
function toRows(c: Record<string, unknown>): (string | number)[][] {
  const addresses = (c.Addresses as LiveAddress[] | undefined) ?? [];
  return addresses.map((a) => [
    "Create/Update", str(c.Name), str(a.Type), trueFalse(a.DefaultForType),
    str(a.Line1), str(a.Line2), str(a.City), str(a.State), str(a.Postcode), str(a.Country), "",
  ]);
}

/** Full-fidelity export of every customer address currently live in a chosen Cin7 instance, ready for runImport. */
export function toFullCustomerAddressesCsv(customers: Record<string, unknown>[]): string {
  return toCsv([HEADER, ...customers.flatMap(toRows)]);
}
