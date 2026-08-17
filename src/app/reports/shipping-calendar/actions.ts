"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { requireWriteAllowed } from "@/lib/billing";
import { REPORTS_MODULE } from "@/app/module-nav";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { updateSaleShipBy, fetchCarriers, markSaleShipped, type MarkShippedInput } from "@/cin7/sales";
import { recordShipByChange } from "@/lib/ship-by-notifications";
import {
  getOrderFulfillmentReport,
  getOrderFulfillmentLines,
  getReportFilterOptions,
  type OrderFulfillmentRow,
  type OrderFulfillmentLineRow,
  type OrderFulfillmentFilters,
} from "@/reports/query";
import type { InstancePickerItem } from "@/actions/instances";

export interface ShippingCalendarActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ShippingCalendarData {
  orders: OrderFulfillmentRow[];
  lines: OrderFulfillmentLineRow[];
  instances: InstancePickerItem[];
}

/** Every order (+ per-SKU line detail, for the click-to-expand card view), optionally scoped to a subset of connected instances — same instanceIds filter Order Fulfillment uses, since a multi-instance org needs the same ability to isolate one instance's shipments here. */
export async function loadShippingCalendarOrdersAction(filters: OrderFulfillmentFilters = {}): Promise<ShippingCalendarActionResult<ShippingCalendarData>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const [orders, lines, options] = await Promise.all([
      getOrderFulfillmentReport(db, orgId, filters),
      getOrderFulfillmentLines(db, orgId, filters),
      getReportFilterOptions(db, orgId),
    ]);
    return { ok: true, data: { orders, lines, instances: options.instances } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * Writes a new ShipBy date back to Cin7 (drag-to-reschedule) and mirrors it
 * into this app's own synced `sales` row in the same call — otherwise the
 * calendar's optimistic update would drift from the Order Fulfillment
 * report (which reads the synced copy) until the next scheduled sales sync
 * re-pulls ShipBy from Cin7.
 */
export async function updateOrderShipByAction(instanceId: string, saleId: string, shipBy: string): Promise<ShippingCalendarActionResult<void>> {
  try {
    const { orgId, email } = await requireModuleAccess(REPORTS_MODULE.href);
    // Security re-audit P1-3: this writes to Cin7 (updateSaleShipBy below) —
    // requireModuleAccess alone only checks module visibility, not the org's
    // billing plan. Same requireWriteAllowed(orgId) gate every other
    // Cin7-writing action in this app already uses (e.g.
    // src/app/supplier-planner/actions.ts, src/app/audit/actions.ts).
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);

    // Read before write — P4 (LBL brief) needs the pre-change value to
    // report "old date -> new date" in the notification email; a plain
    // UPDATE has no way to recover what a row held before it ran.
    const { data: existing } = await db
      .from("sales")
      .select("ship_by")
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId)
      .maybeSingle();

    await updateSaleShipBy(creds, saleId, shipBy);

    const { error } = await db
      .from("sales")
      .update({ ship_by: shipBy })
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId);
    if (error) throw new Error(`sales table mirror update: ${error.message}`);

    // P4 Phase 1: fires only on this Toolbox-originated write, per the
    // brief's own requirement 1 — hooks the existing write-back path
    // rather than adding a parallel one. No-op unless the org has
    // notifications enabled (recordShipByChange checks this itself).
    await recordShipByChange(db, {
      orgId,
      instanceId,
      cin7SaleId: saleId,
      oldShipBy: existing?.ship_by ?? null,
      newShipBy: shipBy,
      changedByEmail: email,
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Carrier names already on file in this Cin7 instance (`/ref/carrier`) — offered as a pick-list for "mark as shipped" rather than free-typing a name that might not match Cin7's own record. */
export async function loadCarriersAction(instanceId: string): Promise<ShippingCalendarActionResult<string[]>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const carriers = await fetchCarriers(creds);
    return { ok: true, data: carriers.map((c) => c.Description) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

export interface MarkOrderShippedResult {
  /** This Cin7 instance's own web app origin (derived from its API base_url, not a per-order deep link — Cin7's API has no box-label endpoint, so this just gets the user logged in faster to print it from Cin7's own UI). */
  cin7WebUrl: string;
}

/**
 * Marks an order shipped in Cin7 (Fulfilment Ship → AUTHORISED) and mirrors
 * the shipping status into this app's own synced `sales` row in the same
 * call — otherwise the calendar's own "still schedulable" filter (which
 * excludes SHIPPED orders) wouldn't drop this card until the next scheduled
 * sales sync re-pulls CombinedShippingStatus from Cin7.
 */
export async function markOrderShippedAction(
  instanceId: string,
  saleId: string,
  input: MarkShippedInput
): Promise<ShippingCalendarActionResult<MarkOrderShippedResult>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    // Security re-audit P1-3: this writes to Cin7 (markSaleShipped below) —
    // same billing-plan gate every other Cin7-writing action uses.
    await requireWriteAllowed(orgId);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    await markSaleShipped(creds, saleId, input);

    const { error } = await db
      .from("sales")
      .update({ combined_shipping_status: "SHIPPED" })
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId);
    if (error) throw new Error(`sales table mirror update: ${error.message}`);

    return { ok: true, data: { cin7WebUrl: new URL(creds.baseUrl).origin } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
