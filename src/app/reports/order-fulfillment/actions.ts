"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireCurrentOrg } from "@/lib/current-org";
import {
  getOrderFulfillmentReport,
  getOrderFulfillmentLines,
  type OrderFulfillmentFilters,
  type OrderFulfillmentRow,
  type OrderFulfillmentLineRow,
} from "@/reports/query";
import { buildOrderFulfillmentSheet } from "@/reports/order-fulfillment-export";
import { renderXlsxBase64 } from "@/reports/xlsx-writer";

export interface OrderFulfillmentActionResult<T> {
  ok: boolean;
  error?: string;
  data?: T;
}

export interface OrderFulfillmentData {
  orders: OrderFulfillmentRow[];
  lines: OrderFulfillmentLineRow[];
}

/** Loads both the order-level rows and every order's line detail in one round trip — a plain DB read for the whole result set, not a rate-limited per-order Cin7 call, so every row's drill-down is already in hand before the user expands it. */
export async function loadOrderFulfillmentAction(filters: OrderFulfillmentFilters): Promise<OrderFulfillmentActionResult<OrderFulfillmentData>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const [orders, lines] = await Promise.all([getOrderFulfillmentReport(db, orgId, filters), getOrderFulfillmentLines(db, orgId, filters)]);
    return { ok: true, data: { orders, lines } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Renders whatever's currently on screen (the client already has the filtered rows) into a real .xlsx file — same pattern as every other report's export action. */
export async function exportOrderFulfillmentXlsxAction(rows: OrderFulfillmentRow[]): Promise<OrderFulfillmentActionResult<string>> {
  try {
    await requireCurrentOrg();
    const sheet = buildOrderFulfillmentSheet(rows);
    return { ok: true, data: await renderXlsxBase64(sheet, "Order Fulfillment") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
