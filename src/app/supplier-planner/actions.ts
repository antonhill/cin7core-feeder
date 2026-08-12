"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { SUPPLIER_PLANNER_MODULE } from "@/app/module-nav";
import { requireOrgAdmin } from "@/lib/require-org-admin";
import { requireWriteAllowed } from "@/lib/billing";
import { logActivity } from "@/lib/activity-log";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchAllProductsForSupplierPlanning } from "@/cin7/product-supplier-options";
import { createPurchaseOrder } from "@/cin7/purchase-write";
import { getReorderReport, getSupplierPlanLocationDemand } from "@/reports/query";
import { fetchAllLocations, type Cin7Location } from "@/cin7/reference-lookups";
import {
  buildSupplierPlanLines,
  groupLinesForPurchaseOrders,
  type PurchaseOrderFallbackLocation,
  type SupplierPlanExtra,
  type SupplierPlanLine,
  type SupplierPlanLocationDemand,
} from "@/reports/supplier-planner/build";
import { loadPendingPurchaseOrders } from "@/lib/pending-purchase-orders";
import { buildSupplierPlanSheet } from "@/reports/supplier-planner-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

export interface SupplierPlanActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface SupplierPlanParams {
  instanceId: string;
  velocityDateFrom: string;
  velocityDateTo: string;
  periodDays: number;
  bufferPercent: number;
  /** Per-run values for the import-supplier stock floor — pre-filled from purchase_planner_settings by the caller, but not required to match it (a one-off what-if run doesn't have to change the saved org default). null homeCurrency turns the floor off. */
  homeCurrency: string | null;
  importStockMonths: number;
}

export interface PurchasePlannerSettings {
  homeCurrency: string | null;
  importStockMonths: number;
}

const DEFAULT_PURCHASE_PLANNER_SETTINGS: PurchasePlannerSettings = { homeCurrency: null, importStockMonths: 4 };

/** Every org member can read the org's saved defaults — same read-access level as everything else in Purchase Planner. */
export async function getPurchasePlannerSettingsAction(): Promise<SupplierPlanActionResult<PurchasePlannerSettings>> {
  try {
    const { orgId } = await requireModuleAccess(SUPPLIER_PLANNER_MODULE.href);
    const db = createServiceRoleClient();
    const { data } = await db.from("purchase_planner_settings").select("home_currency, import_stock_months").eq("org_id", orgId).maybeSingle();
    if (!data) return { ok: true, data: DEFAULT_PURCHASE_PLANNER_SETTINGS };
    return { ok: true, data: { homeCurrency: data.home_currency, importStockMonths: Number(data.import_stock_months) } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Gated to org owners/admins (requireOrgAdmin) — this changes a shared
 * business-policy default that reshapes every user's suggested quantities,
 * not a personal preference, so it shouldn't be left open to any org member
 * the way reading it is.
 */
export async function savePurchasePlannerSettingsAction(settings: PurchasePlannerSettings): Promise<SupplierPlanActionResult<null>> {
  try {
    const { orgId } = await requireOrgAdmin();
    const db = createServiceRoleClient();
    const { error } = await db.from("purchase_planner_settings").upsert(
      {
        org_id: orgId,
        home_currency: settings.homeCurrency,
        import_stock_months: settings.importStockMonths,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "org_id" }
    );
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface SupplierPlanData {
  lines: SupplierPlanLine[];
  /** Every real location in the account, so the UI can offer a "receiving location" for lines that carry no location of their own — see groupLinesForPurchaseOrders' own comment on why that's most lines, not a rare exception. */
  locations: Cin7Location[];
}

/**
 * Combines a live Cin7 fetch (Suppliers[].ProductSupplierOptions — Lead/
 * Safety/ReorderQuantity/MinimumToReorder, src/cin7/product-supplier-
 * options.ts) with the same sales-velocity/on-hand data the Reorder Report
 * already computes (report_reorder RPC), scoped to this one instance so
 * the live supplier data and the DB-derived stock figures agree. This is
 * the Imports/lead-time-based workflow — see src/reports/supplier-planner/
 * build.ts's header comment for why it stays a separate tool from the
 * Reorder Report rather than merging with it.
 */
export async function loadSupplierPlanAction(params: SupplierPlanParams): Promise<SupplierPlanActionResult<SupplierPlanData>> {
  if (!params.instanceId) return { ok: false, error: "Choose an instance." };

  try {
    const { orgId } = await requireModuleAccess(SUPPLIER_PLANNER_MODULE.href);
    const db = createServiceRoleClient();

    const creds = await loadCin7Credentials(db, orgId, params.instanceId);
    const [products, reorderRows, locationDemandRows, locations, pendingPurchaseOrders] = await Promise.all([
      fetchAllProductsForSupplierPlanning(creds),
      getReorderReport(db, orgId, {
        instanceIds: [params.instanceId],
        velocityDateFrom: params.velocityDateFrom,
        velocityDateTo: params.velocityDateTo,
      }),
      getSupplierPlanLocationDemand(db, orgId, {
        instanceIds: [params.instanceId],
        velocityDateFrom: params.velocityDateFrom,
        velocityDateTo: params.velocityDateTo,
      }),
      fetchAllLocations(creds),
      loadPendingPurchaseOrders(db, orgId, params.instanceId),
    ]);

    const extraBySku = new Map<string, SupplierPlanExtra>(reorderRows.map((r) => [r.product_sku, { moverCategory: r.mover_category, status: r.status }]));

    // Org-wide aggregate — used only as a fallback when a SKU has zero
    // per-location rows at all (see buildSupplierPlanLines' own comment).
    const fallbackBySku = new Map<string, SupplierPlanLocationDemand>(
      reorderRows.map((r) => [r.product_sku, { onHand: r.on_hand, onOrder: r.on_order, totalOut: r.total_out }])
    );

    const byLocation = new Map<string, Map<string, SupplierPlanLocationDemand>>();
    for (const row of locationDemandRows) {
      let locs = byLocation.get(row.product_sku);
      if (!locs) {
        locs = new Map();
        byLocation.set(row.product_sku, locs);
      }
      locs.set(row.location, { onHand: row.on_hand, onOrder: row.on_order, totalOut: row.total_out });
    }

    const locationIdByName = new Map(locations.map((l) => [l.name, l.id]));

    const lines = buildSupplierPlanLines(
      products,
      { byLocation, fallbackBySku, locationIdByName },
      { bufferPercent: params.bufferPercent, periodDays: params.periodDays, homeCurrency: params.homeCurrency, importStockMonths: params.importStockMonths },
      extraBySku,
      pendingPurchaseOrders
    );

    return { ok: true, data: { lines, locations } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen (post-filter) into a real .xlsx file — same pattern as exportReorderReportXlsxAction. */
export async function exportSupplierPlanXlsxAction(lines: SupplierPlanLine[]): Promise<SupplierPlanActionResult<string>> {
  try {
    await requireModuleAccess(SUPPLIER_PLANNER_MODULE.href);
    const sheet = buildSupplierPlanSheet(lines);
    return { ok: true, data: await renderXlsxBase64(sheet, "Purchase Planner") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface CreatedPurchaseOrder {
  supplierName: string;
  locationName: string;
  orderNumber: string;
  status: string;
  lineCount: number;
}

export interface FailedPurchaseOrder {
  supplierName: string;
  locationName: string;
  error: string;
}

export interface CreatePurchaseOrdersResult {
  created: CreatedPurchaseOrder[];
  failed: FailedPurchaseOrder[];
}

/**
 * Creates one real DRAFT Purchase Order per (supplier, location) group of
 * selected lines — see src/reports/supplier-planner/build.ts's
 * groupLinesForPurchaseOrders for why it's (supplier, location) and not
 * just supplier, and src/cin7/purchase-write.ts's createPurchaseOrder for
 * the confirmed two-step Cin7 write shape (7 rounds of live trial-and-error,
 * src/cin7/debug.ts's testCreatePurchaseOrder).
 *
 * Unlike createReplenishTransfersAction's single top-level try/catch (which
 * loses activity-log evidence of already-succeeded groups if a later one
 * fails), this catches per-group — a failure partway through still reports
 * and logs whichever POs genuinely got created in Cin7, rather than
 * silently discarding that they happened.
 */
export async function createSupplierPlanPurchaseOrdersAction(
  instanceId: string,
  lines: SupplierPlanLine[],
  fallbackLocation?: PurchaseOrderFallbackLocation
): Promise<SupplierPlanActionResult<CreatePurchaseOrdersResult>> {
  if (!instanceId) return { ok: false, error: "Choose an instance." };
  if (!lines.length) return { ok: false, error: "Select at least one line to create a PO from." };

  try {
    const { orgId, userId, email } = await requireModuleAccess(SUPPLIER_PLANNER_MODULE.href);
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    const groups = groupLinesForPurchaseOrders(lines, fallbackLocation);
    if (!groups.length) {
      return {
        ok: false,
        error:
          "None of the selected lines have a specific location, and no receiving location was chosen — a Purchase Order needs exactly one. Choose a receiving location above and try again.",
      };
    }
    const created: CreatedPurchaseOrder[] = [];
    const failed: FailedPurchaseOrder[] = [];

    for (const group of groups) {
      try {
        const result = await createPurchaseOrder(creds, {
          supplierName: group.supplierName,
          supplierId: group.supplierId,
          locationName: group.locationName,
          locationId: group.locationId,
          lines: group.lines.map((l) => ({
            productId: l.productId,
            sku: l.productSku,
            name: l.productName,
            quantity: l.suggestedQty,
            price: l.cost ?? 0,
          })),
        });
        created.push({
          supplierName: group.supplierName,
          locationName: group.locationName,
          orderNumber: result.orderNumber,
          status: result.status,
          lineCount: result.lineCount,
        });

        // Best-effort: this app's own memory of what it just created, so
        // Supplier Planner can flag these exact lines as "already ordered,
        // pending authorization" next time it loads (see
        // loadPendingPurchaseOrders above). A failure here shouldn't
        // undermine the fact that a real PO now exists in Cin7.
        const { error: recordError } = await db.from("supplier_plan_created_po_lines").insert(
          group.lines.map((l) => ({
            org_id: orgId,
            instance_id: instanceId,
            cin7_purchase_id: result.taskId,
            order_number: result.orderNumber,
            supplier_id: group.supplierId,
            location_id: group.locationId,
            product_sku: l.productSku,
          }))
        );
        if (recordError) console.error("supplier_plan_created_po_lines insert failed:", recordError.message);
      } catch (e) {
        failed.push({
          supplierName: group.supplierName,
          locationName: group.locationName,
          error: e instanceof Error ? e.message : "Unknown error",
        });
      }
    }

    if (created.length) {
      await logActivity(db, {
        orgId,
        instanceId,
        actor: { userId, email },
        action: "supplier_planner.create_purchase_order",
        summary: `Created ${created.length} draft PO${created.length === 1 ? "" : "s"} across ${new Set(created.map((c) => c.supplierName)).size} supplier${new Set(created.map((c) => c.supplierName)).size === 1 ? "" : "s"}${failed.length ? ` (${failed.length} failed)` : ""}`,
        detail: { created, failed },
      });
    }

    return {
      ok: failed.length === 0,
      data: { created, failed },
      error: failed.length ? `${failed.length} of ${groups.length} PO(s) failed to create` : undefined,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
