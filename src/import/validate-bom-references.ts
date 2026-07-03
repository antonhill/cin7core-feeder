import type { SupabaseClient } from "@supabase/supabase-js";
import type { InvalidRow, ParsedRow } from "@/import/csv";
import { findMissingSkus } from "@/import/check-existing-skus";
import type { AssemblyBomCsvRow } from "@/model/assembly-bom";
import type { ProductionBomCsvRow } from "@/model/production-bom";

export interface ReferenceCheckResult<T> {
  valid: ParsedRow<T>[];
  invalid: InvalidRow[];
}

/**
 * Every parent and component SKU in a BOM must already exist as a product —
 * BOMs are not allowed to implicitly create products. A row referencing an
 * unknown SKU is rejected (not committed), same as a schema-validation
 * failure, so it shows up in the same invalid-rows report.
 */
export async function checkAssemblyBomReferences(
  db: SupabaseClient,
  orgId: string,
  rows: ParsedRow<AssemblyBomCsvRow>[]
): Promise<ReferenceCheckResult<AssemblyBomCsvRow>> {
  const skus = rows.flatMap((r) => [r.data.ProductSKU, r.data.ComponentSKU]);
  const missing = await findMissingSkus(db, orgId, skus);

  const valid: ParsedRow<AssemblyBomCsvRow>[] = [];
  const invalid: InvalidRow[] = [];
  for (const row of rows) {
    const errors: string[] = [];
    if (missing.has(row.data.ProductSKU)) {
      errors.push(`ProductSKU "${row.data.ProductSKU}" does not exist — import it as a product first`);
    }
    if (missing.has(row.data.ComponentSKU)) {
      errors.push(`ComponentSKU "${row.data.ComponentSKU}" does not exist — import it as a product first`);
    }
    if (errors.length) invalid.push({ rowNumber: row.rowNumber, raw: row.raw, errors });
    else valid.push(row);
  }
  return { valid, invalid };
}

/**
 * Same rule for Production BOMs, except Resource item rows (work-centre
 * resources like labour/machine time) are not products and are exempt —
 * only the parent SKU and Component-type item rows are checked.
 */
export async function checkProductionBomReferences(
  db: SupabaseClient,
  orgId: string,
  rows: ParsedRow<ProductionBomCsvRow>[]
): Promise<ReferenceCheckResult<ProductionBomCsvRow>> {
  const parentSkus = rows.map((r) => r.data.ProductSKU);
  const componentSkus = rows
    .filter((r) => r.data.ItemType === "Component")
    .map((r) => r.data.ComponentSKU_ResourceCode);
  const missing = await findMissingSkus(db, orgId, [...parentSkus, ...componentSkus]);

  const valid: ParsedRow<ProductionBomCsvRow>[] = [];
  const invalid: InvalidRow[] = [];
  for (const row of rows) {
    const errors: string[] = [];
    if (missing.has(row.data.ProductSKU)) {
      errors.push(`ProductSKU "${row.data.ProductSKU}" does not exist — import it as a product first`);
    }
    if (row.data.ItemType === "Component" && missing.has(row.data.ComponentSKU_ResourceCode)) {
      errors.push(`ComponentSKU "${row.data.ComponentSKU_ResourceCode}" does not exist — import it as a product first`);
    }
    if (errors.length) invalid.push({ rowNumber: row.rowNumber, raw: row.raw, errors });
    else valid.push(row);
  }
  return { valid, invalid };
}
