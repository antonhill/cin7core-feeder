import type { SupabaseClient } from "@supabase/supabase-js";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { fetchAllCustomers } from "@/cin7/customers";
import { fetchAllSuppliers } from "@/cin7/suppliers";
import { toFullInventoryListCsv } from "@/export/products-csv-live";
import { toFullAssemblyBomCsv } from "@/export/assembly-bom-csv-live";
import { toFullCustomersCsv } from "@/export/customers-csv-live";
import { toFullCustomerAddressesCsv } from "@/export/customer-addresses-csv-live";
import { toFullSuppliersCsv } from "@/export/suppliers-csv-live";
import { toFullSupplierAddressesCsv } from "@/export/supplier-addresses-csv-live";
import { runImport, type ImportKind, type RunImportResult } from "@/import/run-import";

/**
 * A Migrate pull is chunked into 3 resumable groups — one Cin7 fetch (the
 * expensive, rate-limited part) each, feeding 1-2 canonical-table commits.
 * This is the natural fetch boundary the old all-in-one pullInstanceData
 * already had (it just Promise.all'd all 3 up front): products+BOM share
 * one fetch, customers+addresses share one, suppliers+addresses share one.
 * pull-jobs.ts drives one group per chunk so a real catalog's pull+import
 * fits inside Vercel's per-invocation duration limit instead of doing all 6
 * kinds synchronously in one request.
 */
export type PullGroup = "products" | "customers" | "suppliers";
export const PULL_GROUP_ORDER: PullGroup[] = ["products", "customers", "suppliers"];

/**
 * Pulls one group's data live from a connected Cin7 instance and lands it in
 * the org's canonical tables via the exact same runImport path a manual CSV
 * upload goes through — so it gets the same validation, warnings, and audit
 * trail (import_batches/import_rows) for free, no separate code path to
 * maintain.
 *
 * This OVERWRITES the org's canonical data for any Name/SKU that also
 * exists in the source instance — the canonical tables are shared across
 * every connected instance, not scoped to one. That's the intended behavior
 * for a migration (see docs/cin7-api-findings.md's architecture discussion),
 * but it does mean this isn't a safe no-op if the org's canonical data is
 * currently being actively curated from a different source.
 */
export async function pullInstanceGroup(
  db: SupabaseClient,
  orgId: string,
  sourceInstanceId: string,
  group: PullGroup
): Promise<Partial<Record<ImportKind, RunImportResult>>> {
  const creds = await loadCin7Credentials(db, orgId, sourceInstanceId);
  const results: Partial<Record<ImportKind, RunImportResult>> = {};

  if (group === "products") {
    const products = await fetchAllProductsWithBom(creds);
    results.products = await runImport(db, orgId, "products", "migrated-products.csv", toFullInventoryListCsv(products));
    // assembly_bom depends on its component products already existing —
    // validate-bom-references.ts — so it must commit after products, never
    // in a separate later group.
    results.assembly_bom = await runImport(db, orgId, "assembly_bom", "migrated-assembly-bom.csv", toFullAssemblyBomCsv(products));
  } else if (group === "customers") {
    const customers = await fetchAllCustomers(creds);
    results.customers = await runImport(db, orgId, "customers", "migrated-customers.csv", toFullCustomersCsv(customers));
    results.customer_addresses = await runImport(
      db,
      orgId,
      "customer_addresses",
      "migrated-customer-addresses.csv",
      toFullCustomerAddressesCsv(customers)
    );
  } else {
    const suppliers = await fetchAllSuppliers(creds);
    results.suppliers = await runImport(db, orgId, "suppliers", "migrated-suppliers.csv", toFullSuppliersCsv(suppliers));
    results.supplier_addresses = await runImport(
      db,
      orgId,
      "supplier_addresses",
      "migrated-supplier-addresses.csv",
      toFullSupplierAddressesCsv(suppliers)
    );
  }

  return results;
}
