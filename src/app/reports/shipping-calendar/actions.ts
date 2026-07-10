"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { updateSaleShipBy } from "@/cin7/sales";
import { getOrderFulfillmentReport, getOrderFulfillmentLines, type OrderFulfillmentRow, type OrderFulfillmentLineRow } from "@/reports/query";

export interface ShippingCalendarActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface ShippingCalendarData {
  orders: OrderFulfillmentRow[];
  lines: OrderFulfillmentLineRow[];
}

/** Every order (+ per-SKU line detail, for the click-to-expand card view) across every connected instance — the calendar itself filters down to ones with a ship_by date set, so no instance picker is needed here (unlike Order Fulfillment, which also drives a per-instance sync button). */
export async function loadShippingCalendarOrdersAction(): Promise<ShippingCalendarActionResult<ShippingCalendarData>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const [orders, lines] = await Promise.all([getOrderFulfillmentReport(db, orgId, {}), getOrderFulfillmentLines(db, orgId, {})]);
    return { ok: true, data: { orders, lines } };
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
