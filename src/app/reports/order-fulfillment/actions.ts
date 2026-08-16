"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { REPORTS_MODULE } from "@/app/module-nav";
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
import { logActivity } from "@/lib/activity-log";

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
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
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
    await requireModuleAccess(REPORTS_MODULE.href);
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
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const creds = await loadCin7Credentials(db, orgId, instanceId);
    const detail = await fetchSaleDetail(creds, saleId);
    return { ok: true, data: detail.Attachments ?? [] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * P2 (LBL brief) Box Label Queue: records that dispatch has printed this
 * sale's box label — a Toolbox-local flag (box_label_print_state, migration
 * 0063), NEVER written to Cin7. This, not Cin7 attachment detection, is the
 * real "drops off the queue" mechanism (see that migration's own comment on
 * why bulk attachment auto-clear isn't built — no timestamp field to verify
 * "added after the invoice," and a live per-row Cin7 call for a whole queue
 * would be the exact N+1-at-list-scale cost this codebase avoids
 * elsewhere). Not gated by requireWriteAllowed — that billing gate is
 * scoped to actions that write back to Cin7 itself; this is pure Toolbox
 * bookkeeping, same category as activity_log, which isn't gated either.
 * Upsert (not insert) so re-clicking after a sync brought back an updated
 * row doesn't error, and so this doubles as an implicit "re-print" record
 * if it's ever clicked again.
 */
export async function markBoxLabelPrintedAction(instanceId: string, saleId: string): Promise<OrderFulfillmentActionResult<void>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const { error } = await db.from("box_label_print_state").upsert(
      {
        org_id: orgId,
        instance_id: instanceId,
        cin7_sale_id: saleId,
        printed_by_email: email ?? "Unknown",
        printed_at: new Date().toISOString(),
      },
      { onConflict: "org_id,instance_id,cin7_sale_id" }
    );
    if (error) return { ok: false, error: error.message };

    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: "order_fulfillment.box_label_printed",
      summary: `Marked box label printed for sale ${saleId}`,
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
