"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { checkSecret } from "@/lib/check-secret";
import { exportProductsCsv } from "@/export/products-csv";
import { exportAssemblyBomCsv } from "@/export/assembly-bom-csv";
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

const TEMPLATE_KINDS = ["products", "assembly_bom"] as const;
type TemplateKind = (typeof TEMPLATE_KINDS)[number];

/**
 * Exports the org's current canonical data as a CSV in the same column
 * format as Cin7's import templates. This is the hub's own canonical data
 * (the single source pushed to every connected instance), not a live pull
 * from one specific Cin7 instance — the result is the same regardless of
 * which instance you'd otherwise push to.
 */
export async function downloadTemplateAction(
  orgId: string,
  secret: string,
  kind: TemplateKind
): Promise<DownloadTemplateResult> {
  const secretError = checkSecret(secret);
  if (secretError) return { ok: false, error: secretError };
  if (!orgId) return { ok: false, error: "Organization ID is required." };
  if (!TEMPLATE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${TEMPLATE_KINDS.join(", ")}` };

  try {
    const db = createServiceRoleClient();
    const csv = kind === "products" ? await exportProductsCsv(db, orgId) : await exportAssemblyBomCsv(db, orgId);
    const filename = kind === "products" ? "InventoryList_export.csv" : "AssemblyBOM_export.csv";
    return { ok: true, csv, filename };
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
export async function downloadLiveTemplateAction(
  orgId: string,
  secret: string,
  instanceId: string,
  kind: TemplateKind
): Promise<DownloadTemplateResult> {
  const secretError = checkSecret(secret);
  if (secretError) return { ok: false, error: secretError };
  if (!orgId) return { ok: false, error: "Organization ID is required." };
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!TEMPLATE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of ${TEMPLATE_KINDS.join(", ")}` };

  try {
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
