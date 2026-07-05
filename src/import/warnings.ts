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

/**
 * Cin7's own Customers CSV template docs (confirmed by Anton 2026-07-05) list
 * Name, PaymentTerm, TaxRule and PriceTier as required — our schema leaves
 * the latter three optional so a partial import can still commit for review,
 * but a blank one here will fail on push, so it's worth flagging early. This
 * is instance-independent (unlike account-code existence, which needs a real
 * chart of accounts to check against — see the module comment above).
 */
export function checkBlankCustomerRequiredFields(rows: ParsedRow<CustomerCsvRow>[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const r of rows) {
    if (!r.data.PaymentTerm.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${r.data.Name}": PaymentTerm is blank — Cin7 requires this for customers` });
    }
    if (!r.data.TaxRule.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${r.data.Name}": TaxRule is blank — Cin7 requires this for customers` });
    }
    if (!r.data.PriceTier.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${r.data.Name}": PriceTier is blank — Cin7 requires this for customers` });
    }
  }
  return warnings;
}

/**
 * Cin7's own Suppliers CSV template docs (confirmed by Anton 2026-07-06) list
 * Name, PaymentTerm and TaxRule as required — no PriceTier equivalent for
 * suppliers (that field doesn't exist on the Supplier model at all). Same
 * instance-independent blank check as the customer version above.
 */
export function checkBlankSupplierRequiredFields(rows: ParsedRow<SupplierCsvRow>[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const r of rows) {
    if (!r.data.PaymentTerm.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${r.data.Name}": PaymentTerm is blank — Cin7 requires this for suppliers` });
    }
    if (!r.data.TaxRule.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${r.data.Name}": TaxRule is blank — Cin7 requires this for suppliers` });
    }
  }
  return warnings;
}

/** The subset of Customer/Supplier CSV columns describing one contact — both templates share this exact shape. */
interface ContactRowFields {
  Name: string;
  ContactName: string;
  Phone: string;
  MobilePhone: string;
  Fax: string;
  Email: string;
  Website: string;
  ContactComment: string;
}

/**
 * Cin7 requires a contact Name whenever any other contact detail is present
 * — our own commit step already silently drops a contact row with details
 * but no name (see commit-customers.ts/commit-suppliers.ts), so without this
 * warning that data just vanishes with no indication anything was lost.
 */
export function checkContactMissingName(rows: ParsedRow<ContactRowFields>[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const r of rows) {
    const { Name, ContactName, Phone, MobilePhone, Fax, Email, Website, ContactComment } = r.data;
    const hasContactDetail = [Phone, MobilePhone, Fax, Email, Website, ContactComment].some((v) => v.trim());
    if (!ContactName.trim() && hasContactDetail) {
      warnings.push({
        rowNumber: r.rowNumber,
        message: `"${Name}": has contact details (e.g. Email/Phone) but no ContactName — Cin7 requires a name for a contact, so this contact will be dropped`,
      });
    }
  }
  return warnings;
}
