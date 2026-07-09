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
import { loadCin7Credentials } from "@/cin7/load-credentials";
import { fetchSaleDetail, type Cin7SaleAttachment } from "@/cin7/sales";

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

/**
 * Fetches an order's attachments (e.g. Cin7's own auto-generated pick list
 * PDF) fresh, on demand — deliberately never synced/stored, since a real
 * order's DownloadUrl carries what looks like a signed/expiring `timeStamp`
 * param (confirmed live 2026-07-09). `loadCin7Credentials` scopes by both
 * orgId and instanceId, so a sale ID from another org's instance can't be
 * probed through this action.
 */
export async function loadSaleAttachmentsAction(instanceId: string, saleId: string): Promise<OrderFulfillmentActionResult<Cin7SaleAttachment[]>> {
  try {
    const { orgId } = await requireCurrentOrg();
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const detail = await fetchSaleDetail(creds, saleId);
    return { ok: true, data: detail.Attachments ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
