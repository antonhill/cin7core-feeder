import { toCsv } from "@/export/csv-format";

/** Full SupplierAddresses CSV template header, matching model/supplier-addresses.ts's schema column order. */
const HEADER = [
  "Action", "Name", "AddressType", "AddressDefaultForType",
  "AddressLine1", "AddressLine2", "City", "State", "Postcode", "Country",
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
 * Maps one raw Cin7 GET /supplier record's nested Addresses[] (see
 * fetchAllSuppliers, docs/cin7-api-findings.md §10) to SupplierAddresses CSV
 * rows — same shape as customer-addresses-csv-live.ts, minus IsParent (which
 * doesn't exist on the Supplier address model at all).
 */
function toRows(s: Record<string, unknown>): (string | number)[][] {
  const addresses = (s.Addresses as LiveAddress[] | undefined) ?? [];
  return addresses.map((a) => [
    "Create/Update", str(s.Name), str(a.Type), trueFalse(a.DefaultForType),
    str(a.Line1), str(a.Line2), str(a.City), str(a.State), str(a.Postcode), str(a.Country),
  ]);
}

/** Full-fidelity export of every supplier address currently live in a chosen Cin7 instance, ready for runImport. */
export function toFullSupplierAddressesCsv(suppliers: Record<string, unknown>[]): string {
  return toCsv([HEADER, ...suppliers.flatMap(toRows)]);
}
