"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { requireWriteAllowed } from "@/lib/billing";
import { logActivity } from "@/lib/activity-log";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForReplenish, type ReplenishProduct } from "@/cin7/product-reorder";
import { fetchAllLocations, type Cin7Location } from "@/cin7/reference-lookups";
import { applyProductFixes, type ProductFix, type ApplyFixesResult } from "@/audit/apply-fixes";
import type { ReorderConfigLine } from "@/reports/replenish/reorder-config";

export interface ReorderConfigActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ReorderConfigPreviewData {
  products: ReplenishProduct[];
  locations: Cin7Location[];
}

/**
 * Fetches every product live from the chosen instance (Category/Brand/full
 * ReorderLevels included) plus every real location (with its GUID, from
 * Cin7's own reference book — not just the names product_availability
 * happens to have synced, since a location can be a valid write target
 * even with zero current stock). No canonical-DB detour, same reasoning
 * as Replenish's own transfer-preview action. Deliberately does NOT filter
 * or compute proposed lines itself — the client runs
 * filterReorderConfigProducts/buildReorderConfigLines directly, so
 * changing the category/brand/search filters or the target location/
 * values recomputes instantly with no extra round trip.
 */
export async function loadReorderConfigPreviewAction(instanceId: string): Promise<ReorderConfigActionResult<ReorderConfigPreviewData>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const [products, locations] = await Promise.all([fetchAllProductsForReplenish(creds), fetchAllLocations(creds)]);
    return { ok: true, data: { products, locations } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Pushes each proposed line's COMPLETE ReorderLevels array — never just the
 * changed entry — via the same `applyProductFixes` PUT-per-product path
 * Data Audit/Bulk Pricing already use. Confirmed live 2026-07-14: Cin7
 * replaces the whole array on write, and `LocationID` is required on every
 * entry (not just `LocationName`) for the write to succeed at all.
 */
export async function applyReorderConfigAction(instanceId: string, lines: ReorderConfigLine[]): Promise<ReorderConfigActionResult<ApplyFixesResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!lines.length) return { ok: false, error: "Nothing to apply." };
  try {
    const { orgId, userId, email } = await requireCurrentOrg();
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const fixes: ProductFix[] = lines.map((line) => ({
      productId: line.productId,
      fields: {
        ReorderLevels: line.newReorderLevels.map((l) => ({
          LocationID: l.locationId,
          LocationName: l.locationName,
          MinimumBeforeReorder: l.minimumBeforeReorder,
          ReorderQuantity: l.reorderQuantity,
          StockLocator: l.stockLocator ?? "",
          PickZones: l.pickZones ?? "",
        })),
      },
    }));
    const result = await applyProductFixes(creds, fixes);

    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: "replenish.reorder_config_update",
      summary: `Updated the reorder point on ${result.succeeded} product${result.succeeded === 1 ? "" : "s"}${
        result.failed.length ? ` (${result.failed.length} failed)` : ""
      }`,
      detail: { lines, failed: result.failed },
    });

    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
