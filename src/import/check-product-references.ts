import type { SupabaseClient } from "@supabase/supabase-js";
import type { ParsedRow } from "@/import/csv";
import type { ProductCsvRow } from "@/model/products";
import type { ImportWarning } from "@/import/warnings";
import { findMissingSupplierNames } from "@/import/check-existing-names";

/**
 * LastSuppliedBy references a Supplier by name — but unlike an address's
 * Name (which must match an already-imported customer/supplier or the row
 * is meaningless), Cin7's Product payload doesn't require the supplier to be
 * pre-resolved: it's sent inline on the nested Suppliers[] array and
 * accepted by name alone (docs/cin7-api-findings.md §5c). So a product row
 * with an unrecognized LastSuppliedBy is still a perfectly valid product —
 * this warns rather than rejects, since the value not matching any of our
 * own suppliers is very likely a typo or a not-yet-imported supplier, worth
 * fixing but not blocking the commit.
 */
export async function checkProductSupplierReference(
  db: SupabaseClient,
  orgId: string,
  rows: ParsedRow<ProductCsvRow>[]
): Promise<ImportWarning[]> {
  const names = rows.map((r) => r.data.LastSuppliedBy).filter((n) => n.trim());
  const missing = await findMissingSupplierNames(db, orgId, names);

  return rows
    .filter((r) => r.data.LastSuppliedBy.trim() && missing.has(r.data.LastSuppliedBy))
    .map((r) => ({
      rowNumber: r.rowNumber,
      message: `"${r.data.Name}": LastSuppliedBy "${r.data.LastSuppliedBy}" doesn't match any existing supplier — check it's been imported, or that it's not a typo`,
    }));
}
