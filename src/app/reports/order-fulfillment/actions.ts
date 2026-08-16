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
import { isOrderFulfillmentExportColumnKey } from "@/reports/order-fulfillment-export-columns";
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

/**
 * Renders whatever's currently on screen (the client already has the
 * filtered rows) into a real .xlsx file — same pattern as every other
 * report's export action. `columnKeys` (P5.5) is the user's column-picker
 * selection, passed straight through to buildOrderFulfillmentSheet — omitted
 * falls back to the original fixed column set.
 */
export async function exportOrderFulfillmentXlsxAction(rows: OrderFulfillmentRow[], columnKeys?: string[]): Promise<OrderFulfillmentActionResult<string>> {
  try {
    await requireModuleAccess(REPORTS_MODULE.href);
    const sheet = buildOrderFulfillmentSheet(rows, columnKeys);
    return { ok: true, data: await renderXlsxBase64(sheet, "Order Fulfillment") };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/**
 * P5.5 (LBL brief): the export column-picker's saved selection — genuinely
 * per-user, not per-org, unlike every other settings table in this app
 * (order_fulfillment_export_columns, migration 0070). Returns null when the
 * user has never customized their columns yet, distinct from an (invalid)
 * empty array — the client falls back to the default column set either way,
 * but null vs [] lets it distinguish "never set" from "explicitly saved as
 * empty" if that ever matters later.
 */
export async function loadOrderFulfillmentExportColumnsAction(): Promise<OrderFulfillmentActionResult<string[] | null>> {
  try {
    const { orgId, userId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const { data, error } = await db
      .from("order_fulfillment_export_columns")
      .select("columns")
      .eq("org_id", orgId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) return { ok: false, error: error.message };
    return { ok: true, data: (data?.columns as string[] | undefined) ?? null };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}

/** Upserts the current user's own export column selection — always scoped to requireModuleAccess's own resolved userId, never a client-supplied one, so one user can't overwrite another's saved preference. Silently drops any unrecognized key (e.g. leftover from a since-renamed field) rather than persisting garbage. */
export async function saveOrderFulfillmentExportColumnsAction(columns: string[]): Promise<OrderFulfillmentActionResult<void>> {
  try {
    const { orgId, userId } = await requireModuleAccess(REPORTS_MODULE.href);
    const known = columns.filter(isOrderFulfillmentExportColumnKey);
    const db = createServiceRoleClient();
    const { error } = await db
      .from("order_fulfillment_export_columns")
      .upsert({ org_id: orgId, user_id: userId, columns: known, updated_at: new Date().toISOString() }, { onConflict: "org_id,user_id" });
    if (error) return { ok: false, error: error.message };
    return { ok: true };
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

/**
 * Undoes a mistaken "Mark as printed" click — deletes the box_label_print_state
 * row outright (not a soft-clear) so the order is judged purely on its live
 * is_ready_for_box_label qualification again, same as if it had never been
 * marked. Scoped to requireModuleAccess's own orgId, so a sale ID from
 * another org can't be targeted. Not an error if the row is already gone
 * (e.g. two tabs open, or it was already unmarked) — that's the same end
 * state the caller wanted, not a failure.
 */
export async function unmarkBoxLabelPrintedAction(instanceId: string, saleId: string): Promise<OrderFulfillmentActionResult<void>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const { error } = await db
      .from("box_label_print_state")
      .delete()
      .eq("org_id", orgId)
      .eq("instance_id", instanceId)
      .eq("cin7_sale_id", saleId);
    if (error) return { ok: false, error: error.message };

    await logActivity(db, {
      orgId,
      instanceId,
      actor: { userId, email },
      action: "order_fulfillment.box_label_unmarked",
      summary: `Unmarked box label printed for sale ${saleId}`,
    });

    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unknown error" };
  }
}
