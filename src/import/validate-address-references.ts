import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvalidRow, ParsedRow } from "@/import/csv";
import { findMissingCustomerNames, findMissingSupplierNames } from "@/import/check-existing-names";
import type { SupplierAddressCsvRow } from "@/model/supplier-addresses";
import type { CustomerAddressCsvRow } from "@/model/customer-addresses";

export interface ReferenceCheckResult<T> {
  valid: ParsedRow<T>[];
  invalid: InvalidRow[];
}

/**
 * A supplier/customer address is always imported as its own separate step
 * (its own CSV, its own "kind") after the supplier/customer it belongs to —
 * same reasoning as Assembly/Production BOM requiring their parent product
 * to already exist (see validate-bom-references.ts). An address row whose
 * Name doesn't match an already-imported supplier is rejected (not
 * committed), same as any other schema-validation failure.
 */
export async function checkSupplierAddressReferences(
  db: SupabaseClient,
  orgId: string,
  rows: ParsedRow<SupplierAddressCsvRow>[]
): Promise<ReferenceCheckResult<SupplierAddressCsvRow>> {
  const missing = await findMissingSupplierNames(db, orgId, rows.map((r) => r.data.Name));

  const valid: ParsedRow<SupplierAddressCsvRow>[] = [];
  const invalid: InvalidRow[] = [];
  for (const row of rows) {
    if (missing.has(row.data.Name)) {
      invalid.push({
        rowNumber: row.rowNumber,
        raw: row.raw,
        errors: [`Name "${row.data.Name}" does not match an existing supplier — import it as a supplier first`],
      });
    } else {
      valid.push(row);
    }
  }
  return { valid, invalid };
}

/** Same rule for Customer Addresses. */
export async function checkCustomerAddressReferences(
  db: SupabaseClient,
  orgId: string,
  rows: ParsedRow<CustomerAddressCsvRow>[]
): Promise<ReferenceCheckResult<CustomerAddressCsvRow>> {
  const missing = await findMissingCustomerNames(db, orgId, rows.map((r) => r.data.Name));

  const valid: ParsedRow<CustomerAddressCsvRow>[] = [];
  const invalid: InvalidRow[] = [];
  for (const row of rows) {
    if (missing.has(row.data.Name)) {
      invalid.push({
        rowNumber: row.rowNumber,
        raw: row.raw,
        errors: [`Name "${row.data.Name}" does not match an existing customer — import it as a customer first`],
      });
    } else {
      valid.push(row);
    }
  }
  return { valid, invalid };
}
