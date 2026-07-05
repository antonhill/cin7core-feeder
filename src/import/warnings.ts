import type { ParsedRow } from "@/import/csv";
import type { SupplierAddressCsvRow } from "@/model/supplier-addresses";
import type { CustomerAddressCsvRow } from "@/model/customer-addresses";
import type { SupplierCsvRow } from "@/model/suppliers";
import type { CustomerCsvRow } from "@/model/customers";

export interface ImportWarning {
  rowNumber: number;
  message: string;
}

/**
 * Cin7 rejects any address push with a blank Country ("Country is required
 * for address" — confirmed live 2026-07-04). This is a plain presence check,
 * independent of which Cin7 instance the data eventually pushes to, so it
 * can be (and is) caught here at import time rather than only surfacing as
 * a push failure later. Non-blocking — the row still commits; this is a
 * warning to fix at the source, not a validation failure.
 */
export function checkBlankCountry(
  rows: ParsedRow<SupplierAddressCsvRow | CustomerAddressCsvRow>[]
): ImportWarning[] {
  return rows
    .filter((r) => !r.data.Country.trim())
    .map((r) => ({ rowNumber: r.rowNumber, message: `"${r.data.Name}" (${r.data.AddressType}): Country is blank — Cin7 will reject this address on push` }));
}

/**
 * Whether an account CODE actually exists only means something against a
 * specific Cin7 instance's chart of accounts (confirmed: pushing an
 * AccountPayable/AccountReceivable/RevenueAccount code Cin7 doesn't
 * recognize fails with "... with specified Code not found", and we
 * deliberately don't auto-create accounts). Import happens before an
 * instance is chosen, so existence can't be checked here — only that the
 * field isn't blank, which is a genuine data gap worth flagging early.
 */
export function checkBlankSupplierAccountPayable(rows: ParsedRow<SupplierCsvRow>[]): ImportWarning[] {
  return rows
    .filter((r) => !r.data.AccountPayable.trim())
    .map((r) => ({ rowNumber: r.rowNumber, message: `"${r.data.Name}": AccountPayable is blank` }));
}

export function checkBlankCustomerAccountCodes(rows: ParsedRow<CustomerCsvRow>[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const r of rows) {
    if (!r.data.AccountReceivable.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${r.data.Name}": AccountReceivable is blank` });
    }
    if (!r.data.SaleAccount.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${r.data.Name}": SaleAccount is blank` });
    }
  }
  return warnings;
}
