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

export const PULLABLE_KINDS: ImportKind[] = [
  "products",
  "assembly_bom",
  "customers",
  "customer_addresses",
  "suppliers",
  "supplier_addresses",
];

export interface PullInstanceResult {
  ok: boolean;
  error?: string;
  instanceName?: string;
  results?: Partial<Record<ImportKind, RunImportResult>>;
}

/**
 * Pulls every Product (+ Assembly BOM), Customer (+ addresses/contacts) and
 * Supplier (+ addresses/contacts) live from one connected Cin7 instance, and
 * lands it in the org's canonical tables via the exact same runImport path a
 * manual CSV upload goes through — so it gets the same validation, warnings,
 * and audit trail (import_batches/import_rows) for free, no separate code
 * path to maintain.
 *
 * Kinds run in parent-before-child order: products before assembly_bom (a
 * BOM line needs its component product to already exist —
 * validate-bom-references.ts), customers before customer_addresses, and
 * suppliers before supplier_addresses (same referential-integrity rule,
 * validate-address-references.ts).
 *
 * This OVERWRITES the org's canonical data for any Name/SKU that also
 * exists in the source instance — the canonical tables are shared across
 * every connected instance, not scoped to one. That's the intended behavior
 * for a migration (see docs/cin7-api-findings.md's architecture discussion),
 * but it does mean this isn't a safe no-op if the org's canonical data is
 * currently being actively curated from a different source.
 */
export async function pullInstanceData(
  db: SupabaseClient,
  orgId: string,
  sourceInstanceId: string
): Promise<PullInstanceResult> {
  try {
    const creds = await loadCin7Credentials(db, orgId, sourceInstanceId);

    const [products, customers, suppliers] = await Promise.all([
      fetchAllProductsWithBom(creds),
      fetchAllCustomers(creds),
      fetchAllSuppliers(creds),
    ]);

    const results: Partial<Record<ImportKind, RunImportResult>> = {};
    results.products = await runImport(db, orgId, "products", "migrated-products.csv", toFullInventoryListCsv(products));
    results.assembly_bom = await runImport(db, orgId, "assembly_bom", "migrated-assembly-bom.csv", toFullAssemblyBomCsv(products));
    results.customers = await runImport(db, orgId, "customers", "migrated-customers.csv", toFullCustomersCsv(customers));
    results.customer_addresses = await runImport(
      db,
      orgId,
      "customer_addresses",
      "migrated-customer-addresses.csv",
      toFullCustomerAddressesCsv(customers)
    );
    results.suppliers = await runImport(db, orgId, "suppliers", "migrated-suppliers.csv", toFullSuppliersCsv(suppliers));
    results.supplier_addresses = await runImport(
      db,
      orgId,
      "supplier_addresses",
      "migrated-supplier-addresses.csv",
      toFullSupplierAddressesCsv(suppliers)
    );

    return { ok: true, instanceName: creds.name, results };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
