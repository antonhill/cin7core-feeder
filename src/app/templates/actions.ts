"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { exportProductsCsv } from "@/export/products-csv";
import { exportAssemblyBomCsv } from "@/export/assembly-bom-csv";
import { exportSuppliersCsv } from "@/export/suppliers-csv";
import { exportCustomersCsv } from "@/export/customers-csv";
import { exportSupplierAddressesCsv } from "@/export/supplier-addresses-csv";
import { exportCustomerAddressesCsv } from "@/export/customer-addresses-csv";
import { toFullInventoryListCsv } from "@/export/products-csv-live";
import { toFullAssemblyBomCsv } from "@/export/assembly-bom-csv-live";
import { fetchAllProductsWithBom } from "@/cin7/products";
import { loadCin7Credentials } from "@/cin7/load-credentials";

export interface DownloadTemplateResult {
  ok: boolean;
  error?: string;
  csv?: string;
  filename?: string;
}

const TEMPLATE_KINDS = [
  "products",
  "assembly_bom",
  "suppliers",
  "supplier_addresses",
  "customers",
  "customer_addresses",
] as const;
type TemplateKind = (typeof TEMPLATE_KINDS)[number];

// Live-pull-from-a-Cin7-instance only exists for products/assembly_bom so
// far — Customers/Suppliers have no confirmed Cin7 API shape yet (push is a
// follow-up), so those four only ever export the hub's own canonical data.
const LIVE_TEMPLATE_KINDS = ["products", "assembly_bom"] as const;
type LiveTemplateKind = (typeof LIVE_TEMPLATE_KINDS)[number];

function isLiveTemplateKind(kind: TemplateKind): kind is LiveTemplateKind {
  return (LIVE_TEMPLATE_KINDS as readonly string[]).includes(kind);
}

/**
 * Exports the org's current canonical data as a CSV in the same column
 * format as Cin7's import templates. This is the hub's own canonical data
 * (the single source pushed to every connected instance), not a live pull
 * from one specific Cin7 instance — the result is the same regardless of
 * which instance you'd otherwise push to.
 */
export async function downloadTemplateAction(kind: TemplateKind): Promise<DownloadTemplateResult> {
  if (!TEMPLATE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${TEMPLATE_KINDS.join(", ")}` };

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();

    const EXPORTERS: Record<TemplateKind, () => Promise<string>> = {
      products: () => exportProductsCsv(db, orgId),
      assembly_bom: () => exportAssemblyBomCsv(db, orgId),
      suppliers: () => exportSuppliersCsv(db, orgId),
      supplier_addresses: () => exportSupplierAddressesCsv(db, orgId),
      customers: () => exportCustomersCsv(db, orgId),
      customer_addresses: () => exportCustomerAddressesCsv(db, orgId),
    };
    const FILENAMES: Record<TemplateKind, string> = {
      products: "InventoryList_export.csv",
      assembly_bom: "AssemblyBOM_export.csv",
      suppliers: "Suppliers_export.csv",
      supplier_addresses: "SupplierAddresses_export.csv",
      customers: "Customers_export.csv",
      customer_addresses: "CustomerAddresses_export.csv",
    };

    const csv = await EXPORTERS[kind]();
    return { ok: true, csv, filename: FILENAMES[kind] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Full-fidelity export pulled live from a specific connected Cin7 instance —
 * every column Cin7's own InventoryList/AssemblyBOM template has, not just
 * the subset the hub's canonical schema tracks. Useful for editing a
 * complete real record and reimporting it, rather than the hub's trimmed
 * canonical view.
 */
export async function downloadLiveTemplateAction(instanceId: string, kind: TemplateKind): Promise<DownloadTemplateResult> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!TEMPLATE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${TEMPLATE_KINDS.join(", ")}` };
  if (!isLiveTemplateKind(kind)) {
    return { ok: false, error: "Live pull isn't available for this data type yet — use hub canonical data instead." };
  }

  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const products = await fetchAllProductsWithBom(creds);
    const csv = kind === "products" ? toFullInventoryListCsv(products) : toFullAssemblyBomCsv(products);
    const filename = kind === "products" ? "InventoryList_live_export.csv" : "AssemblyBOM_live_export.csv";
    return { ok: true, csv, filename };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
