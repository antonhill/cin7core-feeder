"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useSearchParams } from "next/navigation";
import { loadReportFilterOptionsAction, loadSalesSyncStatusAction, triggerSalesSyncAction } from "../actions";
import {
  loadOrderFulfillmentAction,
  exportOrderFulfillmentXlsxAction,
  loadSaleAttachmentsAction,
  markBoxLabelPrintedAction,
  unmarkBoxLabelPrintedAction,
  loadOrderFulfillmentExportColumnsAction,
  saveOrderFulfillmentExportColumnsAction,
} from "./actions";
import type { ReportFilterOptions, OrderFulfillmentRow, OrderFulfillmentLineRow, SalesSyncStatus } from "@/reports/query";
import type { Cin7SaleAttachment } from "@/cin7/sales";
import { buildBatchPickList } from "@/reports/order-fulfillment/pick-list";
import { DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS } from "@/reports/order-fulfillment-export-columns";
import { ExportColumnPicker } from "./ExportColumnPicker";
import { StaleBadge, staleSyncButtonClass } from "../sync-staleness";
import { useResizableColumns, ColGroup, ResizableTh } from "../resizable-columns";
import { compareNullable, type SortDirection } from "../sortable-table";
import { StatusBadge } from "../status-badge";
import { matchesSearch } from "../text-search";
import { SearchInput } from "../search-input";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { ReportDescription } from "../ReportDescription";

type Tab = "pick" | "ship" | "readyToInvoice" | "boxLabel" | "all";

const TABS: { value: Tab; label: string }[] = [
  { value: "pick", label: "Pick Today" },
  { value: "ship", label: "Ship Today" },
  { value: "readyToInvoice", label: "Ready to Invoice" },
  { value: "boxLabel", label: "Box Label Queue" },
  { value: "all", label: "All Orders" },
];

type OrderTableColumn =
  | "select"
  | "order"
  | "shipBy"
  | "picking"
  | "packing"
  | "shipping"
  | "invoice"
  | "invoiceNumbers"
  | "payment"
  | "pickableNow"
  | "readyToInvoiceQty"
  | "boxLabelQty"
  | "boxLabelAction"
  | "paidInvoice";

const ORDER_TABLE_COLUMNS: OrderTableColumn[] = [
  "select",
  "order",
  "shipBy",
  "picking",
  "packing",
  "shipping",
  "invoice",
  "invoiceNumbers",
  "payment",
  "pickableNow",
  "readyToInvoiceQty",
  "boxLabelQty",
  "boxLabelAction",
  "paidInvoice",
];

const ORDER_TABLE_DEFAULT_WIDTHS: Record<OrderTableColumn, number> = {
  select: 40,
  order: 180,
  shipBy: 100,
  picking: 130,
  packing: 130,
  shipping: 130,
  invoice: 130,
  invoiceNumbers: 140,
  payment: 130,
  pickableNow: 120,
  readyToInvoiceQty: 140,
  boxLabelQty: 130,
  boxLabelAction: 170,
  paidInvoice: 140,
};

/** The "select" checkbox column has no sensible sort value; every other column maps to one field (or, for Order, falls back to customer name so an order with no number still sorts sensibly). "boxLabelAction" isn't sortable either — it's a button, not data. */
function orderTableSortValue(column: OrderTableColumn, row: OrderFulfillmentRow): string | number | null {
  switch (column) {
    case "order":
      return row.order_number ?? row.customer_name;
    case "shipBy":
      return row.ship_by;
    case "picking":
      return row.combined_picking_status;
    case "packing":
      return row.combined_packing_status;
    case "shipping":
      return row.combined_shipping_status;
    case "invoice":
      return row.combined_invoice_status;
    case "invoiceNumbers":
      return row.invoice_numbers;
    case "payment":
      return row.combined_payment_status;
    case "pickableNow":
      return row.total_pickable_qty;
    case "readyToInvoiceQty":
      return row.total_ready_to_invoice_qty;
    case "boxLabelQty":
      return row.total_ready_for_box_label_qty;
    case "paidInvoice":
      return row.paid_amount;
    default:
      return null;
  }
}

/** An order open this many days or more without being fully picked is probably stuck, not just "next in line" — a plain default, not meant to be precisely tuned. */
const STUCK_AFTER_DAYS = 7;

function downloadBase64File(base64: string, filename: string, mimeType: string) {
  const byteChars = atob(base64);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function qty(value: number): string {
  return value.toLocaleString();
}

function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * P2 (LBL brief) Box Label Queue: confirmed live 2026-08-15 (Spark Demo
 * instance, SO-00128) that a real Cin7 box-label attachment is named
 * "BoxLabel+{OrderNumber}+for+{Customer}.pdf" — same "+"-joined convention
 * every other Cin7-generated document here already uses. Case-insensitive
 * prefix match rather than an exact one, matching this codebase's standing
 * rule about not trusting a single observed casing as the only real one.
 */
function isBoxLabelAttachment(filename: string | undefined): boolean {
  return Boolean(filename?.toLowerCase().startsWith("boxlabel"));
}

export default function OrderFulfillmentPage() {
  const { widths: columnWidths, startResize } = useResizableColumns<OrderTableColumn>(ORDER_TABLE_DEFAULT_WIDTHS);

  const [sortColumn, setSortColumn] = useState<OrderTableColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  function handleSort(column: OrderTableColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);

  const [orders, setOrders] = useState<OrderFulfillmentRow[] | null>(null);
  const [lines, setLines] = useState<OrderFulfillmentLineRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, startLoadTransition] = useTransition();

  // Lazy initializer so a deep link like /reports/order-fulfillment?tab=ship
  // (e.g. from the home page's Ship Today widget) opens straight into that
  // tab — read once, not kept in sync afterward, same as this file's other
  // one-time-read patterns.
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<Tab>(() => {
    const requested = searchParams.get("tab");
    return requested === "ship" || requested === "all" ? requested : "pick";
  });
  const [expandedSaleId, setExpandedSaleId] = useState<string | null>(null);

  const [search, setSearch] = useState("");
  const [paymentFilter, setPaymentFilter] = useState("");
  const [shipByFrom, setShipByFrom] = useState("");
  const [shipByTo, setShipByTo] = useState("");
  const [backorderFilter, setBackorderFilter] = useState<"all" | "fulfillable" | "backorder">("all");
  // P5.2: "" means no filter. Deliberately separate from backorderFilter
  // above (which is status-based — a raw total_backorder_qty check) — this
  // one is PO-linkage-based, which is exactly the distinction the client
  // asked to have made explicit (see the select's own title attribute).
  const [backorderPoFilter, setBackorderPoFilter] = useState<"" | "with_po" | "no_po">("");
  // P2 requirement 3: "" means no filter (all coverage states shown).
  const [invoiceCoverageFilter, setInvoiceCoverageFilter] = useState<"" | "not_invoiced" | "partially_invoiced" | "invoiced">("");

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  // P5.5 (LBL brief): starts at the original fixed column set so the very
  // first export (before the saved-preference fetch resolves) behaves
  // exactly as it always has — overwritten below if the user has a saved
  // preference on this org.
  const [exportColumnKeys, setExportColumnKeys] = useState<string[]>(DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS);
  const [showColumnPicker, setShowColumnPicker] = useState(false);
  const [isSavingColumns, startSaveColumnsTransition] = useTransition();
  const [columnsSaveError, setColumnsSaveError] = useState<string | null>(null);

  function toggleExportColumn(key: string) {
    setExportColumnKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  function handleSaveExportColumns() {
    setColumnsSaveError(null);
    startSaveColumnsTransition(async () => {
      const result = await saveOrderFulfillmentExportColumnsAction(exportColumnKeys);
      if (!result.ok) {
        setColumnsSaveError(result.error ?? "Unknown error");
        return;
      }
      setShowColumnPicker(false);
    });
  }

  const [syncStatus, setSyncStatus] = useState<SalesSyncStatus | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);
  // Rate-limited queued/detail-phase sync — stale whenever anything at all is still pending, not a time-based signal (backorder/pickable-qty accuracy depends on this).
  const isSalesStale = Boolean(syncStatus) && (syncStatus?.pendingDetail ?? 0) > 0;

  const [attachmentsBySaleId, setAttachmentsBySaleId] = useState<Record<string, Cin7SaleAttachment[]>>({});
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const [isLoadingAttachments, startAttachmentsTransition] = useTransition();

  const [selectedSaleIds, setSelectedSaleIds] = useState<Set<string>>(new Set());
  const [showPickList, setShowPickList] = useState(false);

  // P2 (LBL brief) Box Label Queue — per-sale so one row's in-flight click
  // doesn't disable every "Mark as printed" button on the page.
  const [markingPrintedSaleId, setMarkingPrintedSaleId] = useState<string | null>(null);
  const [markPrintedError, setMarkPrintedError] = useState<string | null>(null);

  function toggleSelected(saleId: string) {
    setSelectedSaleIds((prev) => {
      const next = new Set(prev);
      if (next.has(saleId)) next.delete(saleId);
      else next.add(saleId);
      return next;
    });
  }

  function refreshSyncStatus() {
    loadSalesSyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
  }

  function handleSync() {
    setSyncError(null);
    startSyncTransition(async () => {
      const result = await triggerSalesSyncAction();
      if (!result.ok) {
        setSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshSyncStatus();
      runLoad();
    });
  }

  function handleViewDocuments(instanceId: string, saleId: string) {
    if (attachmentsBySaleId[saleId]) return;
    setAttachmentsError(null);
    startAttachmentsTransition(async () => {
      const result = await loadSaleAttachmentsAction(instanceId, saleId);
      if (!result.ok) {
        setAttachmentsError(result.error ?? "Unknown error");
        return;
      }
      setAttachmentsBySaleId((prev) => ({ ...prev, [saleId]: result.data ?? [] }));
    });
  }

  /**
   * P2 (LBL brief) Box Label Queue: records the Toolbox-local "printed"
   * flag — never a Cin7 write — then refetches the report so this row's
   * is_ready_for_box_label/box_label_printed_at reflect the new state
   * immediately (a plain DB read behind loadOrderFulfillmentAction, not a
   * Cin7 call, so this is cheap).
   */
  function handleMarkBoxLabelPrinted(instanceId: string, saleId: string) {
    setMarkPrintedError(null);
    setMarkingPrintedSaleId(saleId);
    markBoxLabelPrintedAction(instanceId, saleId).then((result) => {
      setMarkingPrintedSaleId(null);
      if (!result.ok) {
        setMarkPrintedError(result.error ?? "Unknown error");
        return;
      }
      runLoad();
    });
  }

  /** Undoes a mistaken "Mark as printed" click — same busy-state/refresh pattern as marking it, just the inverse write. */
  function handleUnmarkBoxLabelPrinted(instanceId: string, saleId: string) {
    setMarkPrintedError(null);
    setMarkingPrintedSaleId(saleId);
    unmarkBoxLabelPrintedAction(instanceId, saleId).then((result) => {
      setMarkingPrintedSaleId(null);
      if (!result.ok) {
        setMarkPrintedError(result.error ?? "Unknown error");
        return;
      }
      runLoad();
    });
  }

  function runLoad() {
    setLoadError(null);
    startLoadTransition(async () => {
      const result = await loadOrderFulfillmentAction({ instanceIds: instanceIds.length ? instanceIds : undefined });
      if (!result.ok) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setOrders(result.data?.orders ?? []);
      setLines(result.data?.lines ?? []);
    });
  }

  useEffect(() => {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
    loadSalesSyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
    loadOrderFulfillmentExportColumnsAction().then((result) => {
      if (result.ok && result.data?.length) setExportColumnKeys(result.data);
    });
  }, []);

  // Keyed on instanceIds so toggling a checkbox reloads on its own — it
  // used to silently do nothing until the separate "Refresh" button was
  // clicked, which read as the filter being broken (it wasn't; nothing was
  // just re-fetching). Runs on mount too (instanceIds starts as []), which
  // is also why the previous separate initial-load call was removed rather
  // than kept alongside this one. Direct .then() here (not runLoad/
  // startTransition) so every setState stays inside a .then() callback
  // rather than running synchronously in the effect body — runLoad is for
  // the "Refresh" button, a real user event, where that's fine.
  useEffect(() => {
    loadOrderFulfillmentAction({ instanceIds: instanceIds.length ? instanceIds : undefined }).then((result) => {
      if (!result.ok) {
        setLoadError(result.error ?? "Unknown error");
        return;
      }
      setLoadError(null);
      setOrders(result.data?.orders ?? []);
      setLines(result.data?.lines ?? []);
    });
  }, [instanceIds]);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  const linesBySaleId = useMemo(() => {
    const map = new Map<string, OrderFulfillmentLineRow[]>();
    for (const line of lines) {
      const existing = map.get(line.cin7_sale_id);
      if (existing) existing.push(line);
      else map.set(line.cin7_sale_id, [line]);
    }
    return map;
  }, [lines]);

  const paymentStatusOptions = useMemo(() => {
    if (!orders) return [];
    return [...new Set(orders.map((o) => o.combined_payment_status).filter((s): s is string => Boolean(s)))].sort();
  }, [orders]);

  const visibleRows = useMemo(() => {
    if (!orders) return [];
    let rows = orders;
    if (tab === "pick") rows = rows.filter((o) => o.is_pick_today);
    else if (tab === "ship") rows = rows.filter((o) => o.is_ship_today);
    else if (tab === "readyToInvoice") rows = rows.filter((o) => o.is_ready_to_invoice);
    else if (tab === "boxLabel") rows = rows.filter((o) => o.is_ready_for_box_label);

    // P5.4 (LBL brief): matches order #/customer OR any line's SKU/product
    // name on the order — linesBySaleId is already fetched for the row
    // expand panel, so this is free (no extra query).
    if (search.trim()) {
      rows = rows.filter(
        (o) =>
          matchesSearch(search, o.order_number, o.customer_name) ||
          (linesBySaleId.get(o.cin7_sale_id) ?? []).some((l) => matchesSearch(search, l.product_sku, l.product_name))
      );
    }
    if (paymentFilter) rows = rows.filter((o) => o.combined_payment_status === paymentFilter);
    if (shipByFrom) rows = rows.filter((o) => o.ship_by !== null && o.ship_by >= shipByFrom);
    if (shipByTo) rows = rows.filter((o) => o.ship_by !== null && o.ship_by <= shipByTo);
    if (backorderFilter === "fulfillable") rows = rows.filter((o) => o.total_backorder_qty === 0);
    else if (backorderFilter === "backorder") rows = rows.filter((o) => o.total_backorder_qty > 0);
    // P5.2: PO-linkage-based, independent of backorderFilter above — see
    // that state's own comment. "No open PO" is the actionable procurement
    // list; "with PO" and "no PO" aren't mutually exclusive (a mixed order
    // can match both), so each is its own straightforward boolean filter.
    if (backorderPoFilter === "with_po") rows = rows.filter((o) => o.has_backorder_with_po);
    else if (backorderPoFilter === "no_po") rows = rows.filter((o) => o.has_backorder_no_po);
    // P2 requirement 3: scope any tab (most useful on Ship Today / Box Label
    // Queue) to real invoice coverage, computed server-side from quantities
    // rather than Cin7's own combined_invoice_status string.
    if (invoiceCoverageFilter) rows = rows.filter((o) => o.invoice_coverage_status === invoiceCoverageFilter);

    return rows;
  }, [orders, tab, search, paymentFilter, shipByFrom, shipByTo, backorderFilter, backorderPoFilter, invoiceCoverageFilter, linesBySaleId]);

  const sortedRows = useMemo(() => {
    if (!sortColumn) return visibleRows;
    const copy = [...visibleRows];
    copy.sort((a, b) => {
      const cmp = compareNullable(orderTableSortValue(sortColumn, a), orderTableSortValue(sortColumn, b));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [visibleRows, sortColumn, sortDirection]);

  const counts = orders
    ? {
        pick: orders.filter((o) => o.is_pick_today).length,
        ship: orders.filter((o) => o.is_ship_today).length,
        readyToInvoice: orders.filter((o) => o.is_ready_to_invoice).length,
        boxLabel: orders.filter((o) => o.is_ready_for_box_label).length,
        all: orders.length,
      }
    : null;

  // P5.3 (LBL brief): orders older than the instance's fulfilment_view_start_date
  // are excluded from is_pick_today/is_ship_today/is_ready_to_invoice (see
  // report_order_fulfillment, migrations 0061/0062) but still returned here —
  // All Orders must keep seeing everything, only the queue tabs are gated.
  // Counted from the full `orders` set (not visibleRows) since the point is
  // "how many are hidden from this tab overall," not a count that shrinks as
  // the user narrows their own search.
  const hiddenByFloorCount = orders
    ? tab === "pick"
      ? orders.filter((o) => o.pick_today_hidden_by_floor).length
      : tab === "ship"
        ? orders.filter((o) => o.ship_today_hidden_by_floor).length
        : tab === "readyToInvoice"
          ? orders.filter((o) => o.ready_to_invoice_hidden_by_floor).length
          : tab === "boxLabel"
            ? orders.filter((o) => o.box_label_hidden_by_floor).length
            : 0
    : 0;

  const selectedOrders = useMemo(() => (orders ?? []).filter((o) => selectedSaleIds.has(o.cin7_sale_id)), [orders, selectedSaleIds]);
  const pickList = useMemo(() => buildBatchPickList(selectedOrders, linesBySaleId), [selectedOrders, linesBySaleId]);

  function handleExport() {
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportOrderFulfillmentXlsxAction(visibleRows, exportColumnKeys);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, `order-fulfillment-${tab}.xlsx`, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  return (
    <>
      <div className="print:hidden">
      <ReportDescription title="Order Fulfillment">
        A working dashboard for pick/pack/ship/invoice/payment — not just a status report.{" "}
        <strong>Pick Today</strong>, <strong>Ship Today</strong>, <strong>Ready to Invoice</strong>, and{" "}
        <strong>Box Label Queue</strong> are priority queues (overdue orders first, undated orders last, nothing
        dropped just because it&rsquo;s late or has no ship-by date), each order expandable to the exact SKUs and
        quantities still needed.{" "}
        <strong>Ready to Invoice</strong> and <strong>Box Label Queue</strong> are real per-SKU quantity comparisons
        (authorised-packed vs. invoiced, summed across every fulfilment and invoice on the order) — not the
        sale-level invoice status, which can miss an order that&rsquo;s already been partially invoiced from an
        earlier fulfilment and now needs another.{" "}
        <strong>Box Label Queue</strong>&rsquo;s &ldquo;Mark as printed&rdquo; is a Toolbox-local record, never
        written to Cin7 — it&rsquo;s what actually removes an order from this queue, since Cin7 gives no reliable way
        to detect a label was printed automatically. <strong>All Orders</strong> shows the complete picture across
        every stage.
      </ReportDescription>
      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2">
              {options && <InstanceMultiPicker instances={options.instances} selectedIds={instanceIds} onToggle={toggleInstance} wrap />}
            </div>
            {syncStatus && (
              <p className="mt-2 text-xs text-slate-400">
                {syncStatus.totalSales.toLocaleString()} sale{syncStatus.totalSales === 1 ? "" : "s"} synced
                {syncStatus.pendingDetail > 0 && ` — ${syncStatus.pendingDetail.toLocaleString()} still catching up on line detail`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSalesStale && <StaleBadge label="Behind — sync recommended" />}
            <button type="button" onClick={handleSync} disabled={isSyncing} className={staleSyncButtonClass(isSalesStale, "sm")}>
              {isSyncing && <Spinner className="mr-1.5" />}
              {isSyncing ? "Syncing…" : "Sync sales now"}
            </button>
            <button
              type="button"
              onClick={runLoad}
              disabled={isLoading}
              className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {isLoading && <Spinner className="mr-1.5" />}
              {isLoading ? "Loading…" : "Refresh"}
            </button>
          </div>
        </div>
        {loadError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{loadError}</p>}
        {syncError && <p className="mt-2 text-sm text-red-600">{syncError}</p>}
        {optionsError && <p className="mt-2 text-sm text-red-600">{optionsError}</p>}
      </section>

      {orders && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTab(t.value)}
                  className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                    tab === t.value ? "bg-indigo-600 text-white" : "text-slate-600 hover:bg-slate-50"
                  }`}
                >
                  {t.label}
                  {counts && <span className="ml-1.5 opacity-75">({counts[t.value]})</span>}
                </button>
              ))}
            </div>
            {visibleRows.length > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setShowColumnPicker(true)}
                  className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                  title="Choose which columns Export to Excel includes"
                >
                  Columns…
                </button>
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={isExporting}
                  className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {isExporting ? "Exporting…" : "Export to Excel"}
                </button>
              </div>
            )}
          </div>
          {exportError && <p className="mt-2 text-sm text-red-600">{exportError}</p>}
          {hiddenByFloorCount > 0 && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {hiddenByFloorCount} older order{hiddenByFloorCount === 1 ? "" : "s"} hidden by the start-date setting — visible under All
              Orders, or adjust the setting on{" "}
              <a href="/settings/instances" className="underline">
                Instances
              </a>
              .
            </p>
          )}

          <div className="mt-4 flex flex-wrap items-end gap-3">
            <SearchInput value={search} onChange={setSearch} placeholder="Order #, customer, or SKU" />
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Payment</span>
              <select value={paymentFilter} onChange={(e) => setPaymentFilter(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
                <option value="">All</option>
                {paymentStatusOptions.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Ship by from</span>
              <input type="date" value={shipByFrom} onChange={(e) => setShipByFrom(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Ship by to</span>
              <input type="date" value={shipByTo} onChange={(e) => setShipByTo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Backorders</span>
              <select
                value={backorderFilter}
                onChange={(e) => setBackorderFilter(e.target.value as "all" | "fulfillable" | "backorder")}
                className="rounded-lg border border-slate-300 px-3 py-2"
              >
                <option value="all">All orders</option>
                <option value="fulfillable">Fully fulfillable only (no backorders)</option>
                <option value="backorder">Has backorders only</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Backorder PO status</span>
              <select
                value={backorderPoFilter}
                onChange={(e) => setBackorderPoFilter(e.target.value as typeof backorderPoFilter)}
                className="rounded-lg border border-slate-300 px-3 py-2"
                title="Based on PO linkage (is a backordered line actually covered by an open purchase order?), not order status — separate from the Backorders filter above, which is just a quantity check"
              >
                <option value="">All</option>
                <option value="with_po">Has backorder with PO</option>
                <option value="no_po">Has backorder with NO open PO</option>
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Invoice coverage</span>
              <select
                value={invoiceCoverageFilter}
                onChange={(e) => setInvoiceCoverageFilter(e.target.value as typeof invoiceCoverageFilter)}
                className="rounded-lg border border-slate-300 px-3 py-2"
                title="Based on real invoiced-vs-ordered quantities, not Cin7's own invoice status field"
              >
                <option value="">All</option>
                <option value="not_invoiced">Not invoiced</option>
                <option value="partially_invoiced">Partially invoiced</option>
                <option value="invoiced">Invoiced</option>
              </select>
            </label>
            {(search || paymentFilter || shipByFrom || shipByTo || backorderFilter !== "all" || backorderPoFilter || invoiceCoverageFilter) && (
              <button
                type="button"
                onClick={() => {
                  setSearch("");
                  setPaymentFilter("");
                  setShipByFrom("");
                  setShipByTo("");
                  setBackorderFilter("all");
                  setBackorderPoFilter("");
                  setInvoiceCoverageFilter("");
                }}
                className="rounded-full border border-slate-300 px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                Clear filters
              </button>
            )}
          </div>

          {visibleRows.length === 0 && <p className="mt-4 text-sm text-slate-400">Nothing matches these filters.</p>}

          {selectedSaleIds.size > 0 && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-indigo-200 bg-indigo-50 px-4 py-2.5">
              <span className="text-sm font-medium text-indigo-900">
                {selectedSaleIds.size} order{selectedSaleIds.size === 1 ? "" : "s"} selected for picking
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setShowPickList(true)}
                  className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Generate batch pick list
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedSaleIds(new Set())}
                  className="rounded-full border border-indigo-300 px-3 py-1.5 text-sm font-medium text-indigo-700 hover:bg-indigo-100"
                >
                  Clear selection
                </button>
              </div>
            </div>
          )}

          {visibleRows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full table-fixed text-left text-xs">
                <ColGroup columns={ORDER_TABLE_COLUMNS} widths={columnWidths} />
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="overflow-hidden py-2 pr-4">
                      <input
                        type="checkbox"
                        title="Select all visible orders"
                        checked={visibleRows.every((r) => selectedSaleIds.has(r.cin7_sale_id))}
                        onChange={(e) => {
                          setSelectedSaleIds((prev) => {
                            const next = new Set(prev);
                            for (const r of visibleRows) {
                              if (e.target.checked) next.add(r.cin7_sale_id);
                              else next.delete(r.cin7_sale_id);
                            }
                            return next;
                          });
                        }}
                        className="h-4 w-4"
                      />
                    </th>
                    <ResizableTh column="order" label="Order" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="shipBy" label="Ship By" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="picking" label="Picking" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="packing" label="Packing" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="shipping" label="Shipping" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="invoice" label="Invoice" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="invoiceNumbers" label="Invoice #(s)" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="payment" label="Payment" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="pickableNow" label="Pickable Now" align="right" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="readyToInvoiceQty" label="Qty Awaiting Invoice" align="right" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="boxLabelQty" label="Qty Ready for Label" align="right" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="boxLabelAction" label="Box Label" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <ResizableTh column="paidInvoice" label="Paid / Invoice" align="right" onResizeStart={startResize} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <Fragment key={row.cin7_sale_id}>
                      <tr
                        onClick={() => setExpandedSaleId(expandedSaleId === row.cin7_sale_id ? null : row.cin7_sale_id)}
                        className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                      >
                        <td className="overflow-hidden py-2 pr-4" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="checkbox"
                            checked={selectedSaleIds.has(row.cin7_sale_id)}
                            onChange={() => toggleSelected(row.cin7_sale_id)}
                            className="h-4 w-4"
                          />
                        </td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4">
                          <div className="truncate font-medium text-slate-900">{row.order_number ?? row.cin7_sale_id}</div>
                          <div className="truncate text-xs text-slate-400">{row.customer_name}</div>
                          {(options?.instances.length ?? 0) > 1 && (
                            <div className="truncate text-xs text-slate-300">
                              {options?.instances.find((i) => i.id === row.instance_id)?.name}
                            </div>
                          )}
                        </td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4">
                          <div>{row.ship_by ?? <span className="text-slate-300">—</span>}</div>
                          {row.is_overdue && (
                            <span className="mt-0.5 inline-block whitespace-nowrap rounded-full bg-rose-100 px-2 py-0.5 text-xs font-semibold text-rose-700">
                              Overdue
                            </span>
                          )}
                          {!row.is_overdue && row.is_pick_today && (row.days_open ?? 0) >= STUCK_AFTER_DAYS && (
                            <span
                              title={`Open ${row.days_open} days without being fully picked`}
                              className="mt-0.5 inline-block whitespace-nowrap rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
                            >
                              Stuck ({row.days_open}d)
                            </span>
                          )}
                        </td>
                        <td className="overflow-hidden py-2 pr-4">
                          <StatusBadge status={row.combined_picking_status} />
                        </td>
                        <td className="overflow-hidden py-2 pr-4">
                          <StatusBadge status={row.combined_packing_status} />
                        </td>
                        <td className="overflow-hidden py-2 pr-4">
                          <StatusBadge status={row.combined_shipping_status} />
                        </td>
                        <td className="overflow-hidden py-2 pr-4">
                          <StatusBadge status={row.combined_invoice_status} />
                        </td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4 text-xs text-slate-600">{row.invoice_numbers ?? "—"}</td>
                        <td className="overflow-hidden py-2 pr-4">
                          <StatusBadge status={row.combined_payment_status} />
                        </td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4 text-right font-medium">{qty(row.total_pickable_qty)}</td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4 text-right font-medium">{qty(row.total_ready_to_invoice_qty)}</td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4 text-right font-medium">{qty(row.total_ready_for_box_label_qty)}</td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4" onClick={(e) => e.stopPropagation()}>
                          {row.is_ready_for_box_label ? (
                            <button
                              type="button"
                              onClick={() => handleMarkBoxLabelPrinted(row.instance_id, row.cin7_sale_id)}
                              disabled={markingPrintedSaleId === row.cin7_sale_id}
                              className="rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                            >
                              {markingPrintedSaleId === row.cin7_sale_id ? "Marking…" : "Mark as printed"}
                            </button>
                          ) : row.box_label_printed_at ? (
                            <span className="inline-flex items-center gap-1.5">
                              <span className="text-xs text-emerald-600" title={row.box_label_printed_by_email ?? undefined}>
                                Printed {row.box_label_printed_at.slice(0, 10)}
                              </span>
                              <button
                                type="button"
                                onClick={() => handleUnmarkBoxLabelPrinted(row.instance_id, row.cin7_sale_id)}
                                disabled={markingPrintedSaleId === row.cin7_sale_id}
                                title="Clicked by mistake? Undo it."
                                className="text-xs font-medium text-slate-400 underline hover:text-slate-600 disabled:opacity-50"
                              >
                                {markingPrintedSaleId === row.cin7_sale_id ? "…" : "Unmark"}
                              </button>
                            </span>
                          ) : (
                            <span className="text-xs text-slate-300">—</span>
                          )}
                        </td>
                        <td className="overflow-hidden whitespace-nowrap py-2 pr-4 text-right">
                          {money(row.paid_amount)} / {money(row.invoice_amount)}
                        </td>
                      </tr>
                      {expandedSaleId === row.cin7_sale_id && (
                        <tr>
                          <td colSpan={ORDER_TABLE_COLUMNS.length} className="bg-slate-50 px-4 py-3">
                            <div className="mb-3 flex items-center justify-between">
                              <button
                                type="button"
                                onClick={() => handleViewDocuments(row.instance_id, row.cin7_sale_id)}
                                disabled={isLoadingAttachments || options?.instances.find((i) => i.id === row.instance_id)?.active === false}
                                title={
                                  options?.instances.find((i) => i.id === row.instance_id)?.active === false
                                    ? "Instance disconnected — documents unavailable"
                                    : undefined
                                }
                                className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                              >
                                {isLoadingAttachments && !attachmentsBySaleId[row.cin7_sale_id] ? "Loading documents…" : "View documents"}
                              </button>
                            </div>
                            {attachmentsError && <p className="mb-2 text-xs text-red-600">{attachmentsError}</p>}
                            {markPrintedError && <p className="mb-2 text-xs text-red-600">{markPrintedError}</p>}
                            {row.is_ready_for_box_label &&
                              attachmentsBySaleId[row.cin7_sale_id]?.some((att) => isBoxLabelAttachment(att.FileName)) && (
                                <p className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                                  A box label attachment already exists on this sale in Cin7.
                                  <button
                                    type="button"
                                    onClick={() => handleMarkBoxLabelPrinted(row.instance_id, row.cin7_sale_id)}
                                    disabled={markingPrintedSaleId === row.cin7_sale_id}
                                    className="rounded-full border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50"
                                  >
                                    {markingPrintedSaleId === row.cin7_sale_id ? "Marking…" : "Mark as printed"}
                                  </button>
                                </p>
                              )}
                            {attachmentsBySaleId[row.cin7_sale_id] && (
                              <div className="mb-3">
                                {attachmentsBySaleId[row.cin7_sale_id].length === 0 ? (
                                  <p className="text-xs text-slate-400">No documents attached to this order.</p>
                                ) : (
                                  <ul className="flex flex-wrap gap-2">
                                    {attachmentsBySaleId[row.cin7_sale_id].map((att, i) => (
                                      <li key={att.ID ?? i}>
                                        <a
                                          href={att.DownloadUrl}
                                          target="_blank"
                                          rel="noreferrer"
                                          className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
                                        >
                                          {att.FileName ?? "Document"}
                                        </a>
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </div>
                            )}
                            {(linesBySaleId.get(row.cin7_sale_id) ?? []).length === 0 ? (
                              <p className="text-sm text-slate-400">No line detail synced for this order yet.</p>
                            ) : (
                              <table className="w-full text-left text-xs">
                                <thead>
                                  <tr className="text-slate-500">
                                    <th className="py-1 pr-4">Product</th>
                                    <th className="py-1 pr-4 text-right">Ordered</th>
                                    <th className="py-1 pr-4 text-right">Backordered</th>
                                    <th className="py-1 pr-4 text-right">Picked</th>
                                    <th className="py-1 pr-4 text-right">Packed</th>
                                    <th className="py-1 pr-4 text-right">Pickable Now</th>
                                    <th className="py-1 pr-4 text-right">Packed (Authorised)</th>
                                    <th className="py-1 pr-4 text-right">Invoiced</th>
                                    <th className="py-1 pr-4">Picked From</th>
                                    <th className="py-1 pr-4">Suggested Pick Location</th>
                                    <th className="py-1 pr-4">Backorder ETA</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {(linesBySaleId.get(row.cin7_sale_id) ?? []).map((line, i) => (
                                    <tr key={i} className="border-t border-slate-200">
                                      <td className="whitespace-nowrap py-1 pr-4">
                                        <div className="font-medium text-slate-900">{line.product_name ?? line.product_sku}</div>
                                        <div className="text-slate-400">{line.product_sku}</div>
                                      </td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-right">{qty(line.ordered_qty)}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-right">{qty(line.backorder_qty)}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-right">{qty(line.picked_qty)}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-right">{qty(line.packed_qty)}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-right font-medium">{qty(line.pickable_qty)}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-right">{qty(line.packed_qty_authorised)}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-right">{qty(line.invoiced_qty)}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-slate-500">{line.picked_from_locations ?? "—"}</td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-slate-500">
                                        {line.suggested_pick_location
                                          ? `${line.suggested_pick_location} (${qty(line.suggested_pick_location_on_hand ?? 0)} on hand)`
                                          : "—"}
                                      </td>
                                      <td className="whitespace-nowrap py-1 pr-4 text-slate-500">
                                        {line.backorder_qty <= 0 ? (
                                          "—"
                                        ) : line.backorder_po_number ? (
                                          <>
                                            {line.backorder_po_number} — {line.backorder_eta ?? "no ETA given"}
                                          </>
                                        ) : (
                                          "No open PO found"
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      </div>

      {showColumnPicker && (
        <ExportColumnPicker
          selectedKeys={new Set(exportColumnKeys)}
          onToggle={toggleExportColumn}
          onReset={() => setExportColumnKeys(DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS)}
          onSave={handleSaveExportColumns}
          isSaving={isSavingColumns}
          saveError={columnsSaveError}
          onClose={() => setShowColumnPicker(false)}
        />
      )}

      {showPickList && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/50 print:static print:bg-transparent print:overflow-visible">
          <div className="mx-auto my-8 max-w-3xl rounded-2xl bg-white p-8 shadow-xl print:my-0 print:max-w-none print:rounded-none print:shadow-none">
            <div className="mb-6 flex items-center justify-between print:hidden">
              <h2 className="text-lg font-semibold text-slate-900">Batch Pick List</h2>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => window.print()}
                  className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
                >
                  Print
                </button>
                <button
                  type="button"
                  onClick={() => setShowPickList(false)}
                  className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Close
                </button>
              </div>
            </div>

            <h1 className="hidden text-xl font-semibold text-slate-900 print:block">Batch Pick List</h1>
            <p className="mt-1 text-sm text-slate-500">
              {selectedOrders.length} order{selectedOrders.length === 1 ? "" : "s"}: {selectedOrders.map((o) => o.order_number ?? o.cin7_sale_id).join(", ")}
            </p>

            <h3 className="mt-6 mb-2 text-sm font-semibold text-slate-700">Consolidated pick sheet</h3>
            {pickList.consolidated.length === 0 ? (
              <p className="text-sm text-slate-400">Nothing currently pickable across the selected orders.</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-1.5 pr-4">Location</th>
                    <th className="py-1.5 pr-4">Product</th>
                    <th className="py-1.5 pr-4 text-right">Qty to Pick</th>
                  </tr>
                </thead>
                <tbody>
                  {pickList.consolidated.map((row) => (
                    <tr key={`${row.instanceId}::${row.productSku}`} className="border-b border-slate-100">
                      <td className="py-1.5 pr-4">{row.suggestedPickLocation ?? <span className="text-slate-300">—</span>}</td>
                      <td className="py-1.5 pr-4">
                        <div className="font-medium text-slate-900">{row.productName ?? row.productSku}</div>
                        <div className="text-xs text-slate-400">{row.productSku}</div>
                      </td>
                      <td className="py-1.5 pr-4 text-right font-medium">{qty(row.totalQty)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            <h3 className="mt-8 mb-2 text-sm font-semibold text-slate-700">Per-order breakdown (for packing)</h3>
            {selectedOrders.map((order) => {
              const orderLines = pickList.orders.find((o) => o.cin7SaleId === order.cin7_sale_id);
              return (
                <div key={order.cin7_sale_id} className="mb-4 break-inside-avoid">
                  <p className="text-sm font-medium text-slate-900">
                    {order.order_number ?? order.cin7_sale_id} — {order.customer_name}
                  </p>
                  {!orderLines || orderLines.lines.length === 0 ? (
                    <p className="text-xs text-slate-400">Nothing currently pickable on this order.</p>
                  ) : (
                    <ul className="mt-1 text-xs text-slate-600">
                      {orderLines.lines.map((line, i) => (
                        <li key={i}>
                          {qty(line.qty)} × {line.productName ?? line.productSku} ({line.productSku})
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
