import type { SupabaseClient } from "@supabase/supabase-js";
import { decrypt } from "@/cin7/crypto";
import { pushProduct } from "@/cin7/products";
import { pushAssemblyBoms, type CanonicalAssemblyBomLineRow } from "@/cin7/assembly-bom";
import { pushProductionBom } from "@/cin7/production-bom";
import { Cin7ApiError } from "@/cin7/http";

export interface SyncRunSummary {
  instanceId: string;
  instanceName: string;
  productsCreated: number;
  productsUpdated: number;
  productsSkipped: number;
  productsFailed: number;
  productionBomsPushed: number;
  productionBomsFailed: number;
  errors: { sku: string; error: string }[];
}

function describeError(e: unknown): string {
  if (e instanceof Cin7ApiError) return `[${e.status}] ${e.message}`;
  return e instanceof Error ? e.message : "Unknown error";
}

/**
 * Syncs one org's products (+ their Assembly BOM lines, whose changes are
 * already folded into products.content_hash) and every Production BOM
 * version to one Cin7 Core instance.
 *
 * Change detection: a product is only pushed when its content_hash differs
 * from sync_state.synced_hash for this instance — a no-op re-run does zero
 * writes. Production BOM has no equivalent tracking yet (every version is
 * pushed on every run) since the payload field mapping itself is still
 * unverified — see docs/cin7-api-findings.md.
 *
 * Resilient: a failure on one product/version is recorded and the run
 * continues — one bad row never aborts the whole sync.
 */
export async function syncInstance(db: SupabaseClient, orgId: string, instanceId: string): Promise<SyncRunSummary> {
  const { data: instanceRow, error: instanceError } = await db
    .from("cin7_instances")
    .select("id, name, account_id, application_key_encrypted, base_url, active")
    .eq("id", instanceId)
    .eq("org_id", orgId)
    .single();
  if (instanceError || !instanceRow) throw new Error(instanceError?.message ?? "Instance not found");
  if (!instanceRow.active) throw new Error("Instance is inactive");

  const creds = {
    accountId: instanceRow.account_id,
    applicationKey: decrypt(instanceRow.application_key_encrypted),
    baseUrl: instanceRow.base_url,
  };

  const summary: SyncRunSummary = {
    instanceId,
    instanceName: instanceRow.name,
    productsCreated: 0,
    productsUpdated: 0,
    productsSkipped: 0,
    productsFailed: 0,
    productionBomsPushed: 0,
    productionBomsFailed: 0,
    errors: [],
  };

  const { data: products, error: productsError } = await db
    .from("products")
    .select("sku, name, description, category_code, uom_code, barcode, active, content_hash")
    .eq("org_id", orgId);
  if (productsError) throw new Error(productsError.message);

  const { data: syncStates } = await db
    .from("sync_state")
    .select("sku, synced_hash")
    .eq("org_id", orgId)
    .eq("instance_id", instanceId);
  const syncedHashBySku = new Map((syncStates ?? []).map((s: { sku: string; synced_hash: string | null }) => [s.sku, s.synced_hash]));

  for (const product of products ?? []) {
    if (syncedHashBySku.has(product.sku) && syncedHashBySku.get(product.sku) === product.content_hash) {
      summary.productsSkipped++;
      continue;
    }

    try {
      const { data: priceTiers } = await db
        .from("price_tiers")
        .select("tier_code, amount")
        .eq("org_id", orgId)
        .eq("product_sku", product.sku);

      const { data: bomLines } = await db
        .from("assembly_bom_lines")
        .select(
          "component_sku, quantity, wastage_quantity, wastage_percent, cost_percentage, price_tier, expense_account"
        )
        .eq("org_id", orgId)
        .eq("product_sku", product.sku);

      const pushResult = await pushProduct(creds, product, priceTiers ?? []);

      if (bomLines?.length) {
        const linesByProduct = new Map<string, CanonicalAssemblyBomLineRow[]>([
          [
            product.sku,
            bomLines.map(
              (l: Record<string, unknown>) => ({ ...l, product_sku: product.sku }) as CanonicalAssemblyBomLineRow
            ),
          ],
        ]);
        const bomResults = await pushAssemblyBoms(creds, linesByProduct);
        const failed = bomResults.find((r) => !r.ok);
        if (failed) throw new Error(`Assembly BOM push failed: ${failed.error}`);
      }

      await db.from("sync_state").upsert(
        {
          org_id: orgId,
          instance_id: instanceId,
          sku: product.sku,
          cin7_id: pushResult.cin7Id,
          synced_hash: product.content_hash,
          last_synced_at: new Date().toISOString(),
          last_status: pushResult.status,
          last_error: null,
        },
        { onConflict: "org_id,instance_id,sku" }
      );

      if (pushResult.status === "created") summary.productsCreated++;
      else summary.productsUpdated++;
    } catch (e) {
      const message = describeError(e);
      summary.productsFailed++;
      summary.errors.push({ sku: product.sku, error: message });
      await db.from("sync_state").upsert(
        {
          org_id: orgId,
          instance_id: instanceId,
          sku: product.sku,
          last_synced_at: new Date().toISOString(),
          last_status: "failed",
          last_error: message,
        },
        { onConflict: "org_id,instance_id,sku" }
      );
    }
  }

  const { data: versions } = await db
    .from("production_bom_versions")
    .select("product_sku, version, version_name, quantity_to_produce")
    .eq("org_id", orgId);

  for (const version of versions ?? []) {
    try {
      const { data: operations } = await db
        .from("production_bom_operations")
        .select("operation_sequence, operation_type, operation_name, cycle_time, work_centre_code")
        .eq("org_id", orgId)
        .eq("product_sku", version.product_sku)
        .eq("version", version.version);

      const { data: items } = await db
        .from("production_bom_items")
        .select("operation_sequence, item_type, item_code, quantity")
        .eq("org_id", orgId)
        .eq("product_sku", version.product_sku)
        .eq("version", version.version);

      await pushProductionBom(creds, version, operations ?? [], items ?? []);
      summary.productionBomsPushed++;
    } catch (e) {
      const message = describeError(e);
      summary.productionBomsFailed++;
      summary.errors.push({ sku: `${version.product_sku}:${version.version}`, error: message });
    }
  }

  return summary;
}
