import type { ParsedRow } from "@/import/csv";
import type { SupplierAddressCsvRow } from "@/model/supplier-addresses";
import type { CustomerAddressCsvRow } from "@/model/customer-addresses";
import type { SupplierCsvRow } from "@/model/suppliers";
import type { CustomerCsvRow } from "@/model/customers";
import type { ProductCsvRow } from "@/model/products";
import { parseTrueFalse } from "@/model/csv-helpers";

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
 * A blank AddressLine1 is a genuine data gap worth flagging early — same
 * instance-independent, plain-presence reasoning as the Country check above.
 */
export function checkBlankAddressLine1(
  rows: ParsedRow<SupplierAddressCsvRow | CustomerAddressCsvRow>[]
): ImportWarning[] {
  return rows
    .filter((r) => !r.data.AddressLine1.trim())
    .map((r) => ({ rowNumber: r.rowNumber, message: `"${r.data.Name}" (${r.data.AddressType}): AddressLine1 is blank` }));
}

/**
 * Cin7's own `AddressDefaultForType` field means "the default address *for
 * that Type*" (Billing/Shipping/Business) — a Name can have several
 * addresses of the same Type (e.g. multiple Billing addresses), but only one
 * of them should be flagged default. Two rows both flagged default for the
 * same Name+AddressType is contradictory source data, worth catching before
 * push rather than leaving it to whichever one Cin7 happens to pick.
 */
export function checkMultipleDefaultAddresses(
  rows: ParsedRow<SupplierAddressCsvRow | CustomerAddressCsvRow>[]
): ImportWarning[] {
  const groups = new Map<string, ParsedRow<SupplierAddressCsvRow | CustomerAddressCsvRow>[]>();
  for (const r of rows) {
    if (!parseTrueFalse(r.data.AddressDefaultForType)) continue;
    const key = `${r.data.Name}::${r.data.AddressType}`;
    const group = groups.get(key) ?? [];
    group.push(r);
    groups.set(key, group);
  }

  const warnings: ImportWarning[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const rowNumbers = group.map((r) => r.rowNumber).join(", ");
    for (const r of group) {
      warnings.push({
        rowNumber: r.rowNumber,
        message: `"${r.data.Name}" (${r.data.AddressType}): more than one address is flagged default for this type (rows ${rowNumbers}) — only one should be`,
      });
    }
  }
  return warnings;
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

const PRODUCT_COSTING_METHODS = new Set([
  "FIFO",
  "FIFO - Serial number",
  "FIFO - Batch",
  "FEFO - Serial number",
  "FEFO - Batch",
  "Special - Serial number",
  "Special - Batch",
]);

// Cin7's own InventoryList docs only list Stock/Service/Fixed Asset as valid
// Type values, but `mapCin7ProductType` (model/products.ts) already handles
// Non-Inventory/BillOfMaterials too — treated as valid here rather than
// flagged, since the code deliberately supports them.
const PRODUCT_TYPES = new Set(["Stock", "Service", "Fixed Asset", "Non-Inventory", "BillOfMaterials"]);
const PRODUCT_DROP_SHIP_MODES = new Set(["No Drop Ship", "Optional Drop Ship", "Always Drop Ship"]);
const PRODUCT_STATUSES = new Set(["Active", "Deprecated"]);

/**
 * CostingMethod/Type/DropShip/Status each have a fixed set of valid values
 * per Cin7's own InventoryList docs. Blank is fine (each has a documented
 * default), but an unrecognized value is very likely a typo that Cin7 will
 * either reject on push or silently misinterpret (e.g. `mapCin7ProductType`
 * collapses any unmapped Type to "component"), so it's worth flagging early.
 */
export function checkProductEnumFields(rows: ParsedRow<ProductCsvRow>[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const r of rows) {
    const { Name, CostingMethod, Type, DropShip, Status } = r.data;
    if (CostingMethod.trim() && !PRODUCT_COSTING_METHODS.has(CostingMethod.trim())) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${Name}": CostingMethod "${CostingMethod}" is not a recognized value` });
    }
    if (Type.trim() && !PRODUCT_TYPES.has(Type.trim())) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${Name}": Type "${Type}" is not a recognized value (expected Stock, Service or Fixed Asset)` });
    }
    if (DropShip.trim() && !PRODUCT_DROP_SHIP_MODES.has(DropShip.trim())) {
      warnings.push({
        rowNumber: r.rowNumber,
        message: `"${Name}": DropShip "${DropShip}" is not a recognized value (expected No Drop Ship, Optional Drop Ship or Always Drop Ship)`,
      });
    }
    if (Status.trim() && !PRODUCT_STATUSES.has(Status.trim())) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${Name}": Status "${Status}" is not a recognized value (expected Active or Deprecated)` });
    }
  }
  return warnings;
}

/**
 * AutoAssemble/AutoDisassemble/Sellable are boolean-like fields where Cin7's
 * own field docs describe "True"/"False" as the valid values, but a real
 * live InventoryList export uses "Yes"/"No" for the same fields (confirmed:
 * docs/cin7-templates/InventoryList_2026-07-03.csv). Both conventions parse
 * correctly (see parseYesNo in model/products.ts), so this only warns on a
 * value that's neither — most likely a typo (e.g. "Ture").
 */
export function checkProductBooleanFields(rows: ParsedRow<ProductCsvRow>[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const r of rows) {
    const { Name, AutoAssemble, AutoDisassemble, Sellable } = r.data;
    const fields: [string, string][] = [
      ["AutoAssemble", AutoAssemble],
      ["AutoDisassemble", AutoDisassemble],
      ["Sellable", Sellable],
    ];
    for (const [field, value] of fields) {
      if (value.trim() && !["yes", "no", "true", "false"].includes(value.trim().toLowerCase())) {
        warnings.push({ rowNumber: r.rowNumber, message: `"${Name}": ${field} "${value}" is not a recognized value (expected Yes/No or True/False)` });
      }
    }
  }
  return warnings;
}

/**
 * FixedAssetType is documented as required when Type is "Fixed Asset" and
 * must be left blank for every other type. Type falls back to "Stock" when
 * blank (Cin7's own documented default), so the fallback is what's checked
 * here rather than the raw (possibly blank) CSV value.
 */
export function checkFixedAssetType(rows: ParsedRow<ProductCsvRow>[]): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const r of rows) {
    const { Name, Type, FixedAssetType } = r.data;
    const effectiveType = Type.trim() || "Stock";
    if (effectiveType === "Fixed Asset" && !FixedAssetType.trim()) {
      warnings.push({ rowNumber: r.rowNumber, message: `"${Name}": Type is "Fixed Asset" but FixedAssetType is blank — Cin7 requires this for fixed assets` });
    } else if (effectiveType !== "Fixed Asset" && FixedAssetType.trim()) {
      warnings.push({
        rowNumber: r.rowNumber,
        message: `"${Name}": FixedAssetType is set but Type is "${effectiveType}", not Fixed Asset — Cin7 expects this blank for non-fixed-asset products`,
      });
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
  ContactDefault: string;
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

/**
 * Unlike addresses, a Customer/Supplier contact has no Type dimension — the
 * whole CSV template has just one `ContactDefault` flag per Name — so at
 * most one contact row for a given Name should be flagged default, not one
 * per some sub-category.
 */
export function checkMultipleDefaultContacts(rows: ParsedRow<ContactRowFields>[]): ImportWarning[] {
  const groups = new Map<string, ParsedRow<ContactRowFields>[]>();
  for (const r of rows) {
    if (!parseTrueFalse(r.data.ContactDefault)) continue;
    const group = groups.get(r.data.Name) ?? [];
    group.push(r);
    groups.set(r.data.Name, group);
  }

  const warnings: ImportWarning[] = [];
  for (const group of groups.values()) {
    if (group.length <= 1) continue;
    const rowNumbers = group.map((r) => r.rowNumber).join(", ");
    for (const r of group) {
      warnings.push({
        rowNumber: r.rowNumber,
        message: `"${r.data.Name}": more than one contact is flagged default (rows ${rowNumbers}) — only one should be`,
      });
    }
  }
  return warnings;
}
