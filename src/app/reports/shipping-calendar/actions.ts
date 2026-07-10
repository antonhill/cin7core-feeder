"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { updateSaleShipBy } from "@/cin7/sales";
import {
  getOrderFulfillmentReport,
  getOrderFulfillmentLines,
  getReportFilterOptions,
  type OrderFulfillmentRow,
  type OrderFulfillmentLineRow,
  type OrderFulfillmentFilters,
} from "@/reports/query";

export interface ShippingCalendarActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ShippingCalendarData {
  orders: OrderFulfillmentRow[];
  lines: OrderFulfillmentLineRow[];
  instances: { id: string; name: string }[];
}

/** Every order (+ per-SKU line detail, for the click-to-expand card view), optionally scoped to a subset of connected instances — same instanceIds filter Order Fulfillment uses, since a multi-instance org needs the same ability to isolate one instance's shipments here. */
export async function loadShippingCalendarOrdersAction(filters: OrderFulfillmentFilters = {}): Promise<ShippingCalendarActionResult<ShippingCalendarData>> {
  try {
    const { orgId } = await requireCurrentOrg();
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
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    await updateSaleShipBy(creds, saleId, shipBy);

    const { error } = await db
      .from("sales")
      .update({ ship_by: shipBy })
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId);
    if (error) throw new Error(`sales table mirror update: ${error.message}`);

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
