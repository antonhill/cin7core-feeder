"use server";

import { createServiceRoleClient } from "@/supabase/server";
import { requireModuleAccess } from "@/lib/authorization";
import { REPORTS_MODULE } from "@/app/module-nav";
import {
  getOrderFulfillmentPage,
  getOrderFulfillmentTabCounts,
  getOrderFulfillmentLinesForSales,
  toReportErrorMessage,
  type OrderFulfillmentTableQuery,
  type OrderFulfillmentPage,
  type OrderFulfillmentTabCounts,
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
  /** One page of the current tab, already filtered, searched and sorted in SQL. */
  page: OrderFulfillmentPage;
  /** The nine badge/floor counts, over the whole set — never derived from `page`. */
  counts: OrderFulfillmentTabCounts;
  /** Line detail for the page's own rows only. */
  lines: OrderFulfillmentLineRow[];
}

/**
 * One page of the table, plus the nine counts, plus that page's line detail.
 *
 * Replaces a fetch of the org's entire 12-month set (8,533 orders / 11 MB +
 * 23,571 lines / 12 MB, two concurrent calls) with three bounded ones. The
 * counts come from their own aggregate rather than from the page, because
 * they are facts about the whole set and a page cannot produce them.
 *
 * Lines are fetched for the page's sale ids only — the row-expand panel and
 * the batch pick list ask for what they need separately.
 */
export async function loadOrderFulfillmentPageAction(
  query: OrderFulfillmentTableQuery
): Promise<OrderFulfillmentActionResult<OrderFulfillmentData>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    const [page, counts] = await Promise.all([
      getOrderFulfillmentPage(db, orgId, query),
      getOrderFulfillmentTabCounts(db, orgId, query),
    ]);
    const lines = await getOrderFulfillmentLinesForSales(
      db,
      orgId,
      page.rows.map((r) => r.cin7_sale_id),
      query.instanceIds
    );
    return { ok: true, data: { page, counts, lines } };
  } catch (e) {
    return { ok: false, error: toReportErrorMessage(e, "loadOrderFulfillmentPageAction") };
  }
}

/** Line detail for an explicit set of orders — an expanded row, or the orders selected for a batch pick list. Never the whole org. */
export async function loadOrderFulfillmentLinesAction(
  saleIds: string[],
  instanceIds?: string[]
): Promise<OrderFulfillmentActionResult<OrderFulfillmentLineRow[]>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();
    return { ok: true, data: await getOrderFulfillmentLinesForSales(db, orgId, saleIds, instanceIds) };
  } catch (e) {
    return { ok: false, error: toReportErrorMessage(e, "loadOrderFulfillmentLinesAction") };
  }
}

/**
 * Builds the .xlsx server-side from the SAME filter/search/sort contract the
 * table uses, so an export is the complete filtered result set rather than
 * whichever page happens to be on screen.
 *
 * It used to take `rows` — the browser posted its own filtered array back,
 * which is why next.config.ts still raises serverActions.bodySizeLimit to
 * 10mb. With paging the client no longer holds the full set, so it posts a
 * query instead and the server re-runs it.
 *
 * Fetched in chunks rather than one call: a single unfiltered All Orders
 * export is ~8,500 rows, and json_agg over that measured 2,075-6,936ms —
 * i.e. flirting with the same 8s statement_timeout this whole stream exists
 * to fix. Each chunk is its own bounded statement, so no single query can
 * time out however large the export is. EXPORT_CHUNK_ROWS trades a re-run of
 * the hydration per chunk for that guarantee.
 */
const EXPORT_CHUNK_ROWS = 2_000;
const EXPORT_MAX_ROWS = 75_000;

export async function exportOrderFulfillmentXlsxAction(
  query: OrderFulfillmentTableQuery,
  columnKeys?: string[]
): Promise<OrderFulfillmentActionResult<string>> {
  try {
    const { orgId } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();

    const rows: OrderFulfillmentRow[] = [];
    let offset = 0;
    for (;;) {
      const page = await getOrderFulfillmentPage(db, orgId, { ...query, limit: EXPORT_CHUNK_ROWS, offset });
      rows.push(...page.rows);
      offset += EXPORT_CHUNK_ROWS;
      if (rows.length >= page.totalCount || page.rows.length === 0) break;
      if (rows.length >= EXPORT_MAX_ROWS) {
        return {
          ok: false,
          error: `This export matched over ${EXPORT_MAX_ROWS.toLocaleString()} rows — narrow your filters (date range, instance selection) and try again.`,
        };
      }
    }

    const sheet = buildOrderFulfillmentSheet(rows, columnKeys);
    return { ok: true, data: await renderXlsxBase64(sheet, "Order Fulfillment") };
  } catch (e) {
    return { ok: false, error: toReportErrorMessage(e, "exportOrderFulfillmentXlsxAction") };
  }
}

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
    return { ok: false, error: toReportErrorMessage(e, "loadOrderFulfillmentExportColumnsAction") };
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
    return { ok: false, error: toReportErrorMessage(e, "saveOrderFulfillmentExportColumnsAction") };
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
    return { ok: false, error: toReportErrorMessage(e, "loadSaleAttachmentsAction") };
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
 *
 * Follow-up (`ready_qty_at_mark`, migration 0071): snapshots the CURRENT
 * ready-for-box-label quantity so a later fulfilment that pushes the total
 * higher automatically re-qualifies the order for the queue again — see
 * report_order_fulfillment's own qualifies_box_label condition (qty >
 * ready_qty_at_mark), no longer a plain "has this ever been printed"
 * boolean. Reuses report_order_fulfillment_lines (the same canonical
 * per-line qualification the report itself sums from) rather than
 * re-deriving the math server-side from scratch, scoped to one instance and
 * filtered to this one sale via PostgREST so it stays a cheap targeted
 * lookup, not a full report scan.
 */
export async function markBoxLabelPrintedAction(instanceId: string, saleId: string): Promise<OrderFulfillmentActionResult<void>> {
  try {
    const { orgId, userId, email } = await requireModuleAccess(REPORTS_MODULE.href);
    const db = createServiceRoleClient();

    // Targeted at this ONE sale (migration 0091). It previously called
    // report_order_fulfillment_lines with no date filter at all and then
    // narrowed with PostgREST's .eq(), which computed every line the org has
    // ever had — ~30,510 rows — to read one order's quantities. That call is
    // visible in pg_stat_statements at 1,429 invocations, mean 765ms, max
    // 7,707ms. The _fs form joins the id list into the scans instead.
    const lineRows = await getOrderFulfillmentLinesForSales(db, orgId, [saleId], [instanceId]);
    const readyQtyAtMark = lineRows.reduce((sum, row) => sum + (row.ready_for_box_label_qty ?? 0), 0);

    const { error } = await db.from("box_label_print_state").upsert(
      {
        org_id: orgId,
        instance_id: instanceId,
        cin7_sale_id: saleId,
        printed_by_email: email ?? "Unknown",
        printed_at: new Date().toISOString(),
        ready_qty_at_mark: readyQtyAtMark,
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
    return { ok: false, error: toReportErrorMessage(e, "markBoxLabelPrintedAction") };
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
    return { ok: false, error: toReportErrorMessage(e, "unmarkBoxLabelPrintedAction") };
  }
}
