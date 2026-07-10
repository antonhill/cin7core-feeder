"use client";

import { Fragment, useMemo, useState, useTransition, useEffect } from "react";
import {
  loadReportFilterOptionsAction,
  loadProductSalesReportAction,
  loadProductSalesPivotAction,
  loadSaleLineDetailsAction,
  loadSalesSyncStatusAction,
  triggerSalesSyncAction,
  exportReportXlsxAction,
} from "./actions";
import type { ReportFilterOptions, ProductSalesReportRow, SaleLineDetailRow, SalesSyncStatus } from "@/reports/query";
import type { SalesReportFilters } from "@/reports/query";
import { buildPivotGrid, METRIC_COLUMNS, type PivotCellValues, type PivotGroupBy, type PivotSourceRow } from "@/reports/pivot";
import { buildFlatReportSheet, buildPivotSheet } from "@/reports/export-xlsx";
import { StaleBadge, staleSyncButtonClass } from "./sync-staleness";
import { compareNullable, SortHeader, type SortDirection } from "./sortable-table";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "./ReportDescription";

type GroupBySelection = "none" | PivotGroupBy;

type ProductSalesSortColumn = "product" | "quantity_sold" | "revenue" | "cogs" | "profit" | "margin_percent";

function productSalesSortValue(row: ProductSalesReportRow, column: ProductSalesSortColumn): string | number | null {
  if (column === "product") return row.product_name ?? row.product_sku;
  return row[column];
}

/** Decodes the base64 .xlsx bytes the server rendered and triggers a normal browser download — no server-side file storage involved. */
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

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

function formatCellMetric(key: keyof PivotCellValues, values: PivotCellValues): string {
  if (key === "quantitySold") return values.quantitySold.toLocaleString();
  if (key === "marginPercent") return percent(values.marginPercent);
  return money(values[key] as number);
}

/** The 5 metric sub-header cells repeated under every pivot column group (and once more for the Total group). */
function MetricHeaderCells() {
  return (
    <>
      {METRIC_COLUMNS.map((col) => (
        <th key={col.key} className="py-1 pr-4 text-right text-xs font-normal text-slate-400">
          {col.label}
        </th>
      ))}
    </>
  );
}

/** The 5 metric value cells for one pivot cell (or the row/column/grand total) — null renders as a dash per metric, a genuine gap rather than 0. */
function MetricCells({ values, bold }: { values: PivotCellValues | null; bold?: boolean }) {
  return (
    <>
      {METRIC_COLUMNS.map((col) => (
        <td key={col.key} className={`py-2 pr-4 text-right ${bold ? "font-semibold" : ""}`}>
          {values ? formatCellMetric(col.key, values) : "—"}
        </td>
      ))}
    </>
  );
}

/** Shared invoice-line drill-down, used under both the flat table and the pivot grid — a row expands to this regardless of which view produced it. */
function InvoiceLineDetail({
  colSpan,
  isLoading,
  lines,
}: {
  colSpan: number;
  isLoading: boolean;
  lines: SaleLineDetailRow[] | undefined;
}) {
  return (
    <tr>
      <td colSpan={colSpan} className="bg-slate-50 px-4 py-3">
        {isLoading && !lines && (
          <p className="text-sm text-slate-400">
            <Spinner className="mr-1.5" />
            Loading invoice lines…
          </p>
        )}
        {lines && (
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1 pr-4">Invoice #</th>
                <th className="py-1 pr-4">Invoice date</th>
                <th className="py-1 pr-4">Qty</th>
                <th className="py-1 pr-4">Price</th>
                <th className="py-1 pr-4">Total</th>
                <th className="py-1 pr-4">Avg cost</th>
                <th className="py-1 pr-4">Customer</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={i} className="border-t border-slate-200">
                  <td className="py-1 pr-4">{line.invoiceNumber}</td>
                  <td className="py-1 pr-4">{line.invoiceDate ?? "—"}</td>
                  <td className="py-1 pr-4">{line.quantity ?? "—"}</td>
                  <td className="py-1 pr-4">{money(line.price)}</td>
                  <td className="py-1 pr-4">{money(line.total)}</td>
                  <td className="py-1 pr-4">{money(line.averageCost)}</td>
                  <td className="py-1 pr-4">{line.customerName ?? "—"}</td>
                </tr>
              ))}
              {lines.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-2 text-slate-400">
                    No matching invoice lines.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </td>
    </tr>
  );
}

export default function ReportsPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [syncStatus, setSyncStatus] = useState<SalesSyncStatus | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);
  // Rate-limited queued/detail-phase sync — stale whenever anything at all is still pending, not a time-based signal (revenue/COGS accuracy depends on this).
  const isSalesStale = Boolean(syncStatus) && (syncStatus?.pendingDetail ?? 0) > 0;

  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [categoryCode, setCategoryCode] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [rows, setRows] = useState<ProductSalesReportRow[] | null>(null);
  const [pivotSourceRows, setPivotSourceRows] = useState<PivotSourceRow[] | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [groupBy, setGroupBy] = useState<GroupBySelection>("none");
  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const pivotGrid = useMemo(() => {
    if (groupBy === "none" || !pivotSourceRows) return null;
    return buildPivotGrid(pivotSourceRows, groupBy);
  }, [pivotSourceRows, groupBy]);

  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SaleLineDetailRow[]>>({});
  const [isLoadingDetails, startDetailsTransition] = useTransition();

  const [sortColumn, setSortColumn] = useState<ProductSalesSortColumn>("revenue");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  function handleSort(column: ProductSalesSortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const sortedRows = useMemo(() => {
    if (!rows) return [];
    const copy = [...rows];
    copy.sort((a, b) => {
      const cmp = compareNullable(productSalesSortValue(a, sortColumn), productSalesSortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortColumn, sortDirection]);

  function refreshOptionsAndStatus() {
    loadReportFilterOptionsAction(instanceIds.length ? instanceIds : undefined).then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
    loadSalesSyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
  }

  useEffect(() => {
    loadSalesSyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
  }, []);

  // Location/Category options are instance-scoped (see getReportFilterOptions)
  // so they must refresh whenever the instance selection changes, not just
  // once at mount (this effect covers mount too, since instanceIds starts as
  // []) — otherwise a category/location only present in an unchecked
  // instance stays listed. Also keeps an ALREADY-shown report in sync with
  // the new instance selection rather than letting it silently go stale;
  // skips re-running if no report has been generated yet, matching this
  // page's own "set filters, then Run report" convention for every other
  // filter (an instance toggle is the one exception that self-applies).
  useEffect(() => {
    loadReportFilterOptionsAction(instanceIds.length ? instanceIds : undefined).then((result) => {
      if (!result.ok) {
        setOptionsError(result.error ?? "Unknown error");
        return;
      }
      setOptionsError(null);
      setOptions(result.data ?? null);
    });

    if (rows === null && pivotSourceRows === null) return;
    const filters = currentFilters();
    if (groupBy === "none") {
      loadProductSalesReportAction(filters).then((result) => {
        if (!result.ok) {
          setReportError(result.error ?? "Unknown error");
          return;
        }
        setReportError(null);
        setRows(result.data ?? []);
      });
    } else {
      loadProductSalesPivotAction(filters, groupBy).then((result) => {
        if (!result.ok) {
          setReportError(result.error ?? "Unknown error");
          return;
        }
        setReportError(null);
        setPivotSourceRows(result.data ?? []);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately scoped to instanceIds only; other filters (location/category/dates/groupBy) stay manual-apply via the Run report button
  }, [instanceIds]);

  function handleSync() {
    setSyncError(null);
    startSyncTransition(async () => {
      const result = await triggerSalesSyncAction();
      if (!result.ok) {
        setSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshOptionsAndStatus();
    });
  }

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function currentFilters(): SalesReportFilters {
    return {
      instanceIds: instanceIds.length ? instanceIds : undefined,
      location: location || undefined,
      categoryCode: categoryCode || undefined,
      dateFrom: dateFrom || undefined,
      dateTo: dateTo || undefined,
    };
  }

  function handleRunReport() {
    setReportError(null);
    setRows(null);
    setPivotSourceRows(null);
    setExpandedSku(null);
    setDetails({});
    startRunTransition(async () => {
      if (groupBy === "none") {
        const result = await loadProductSalesReportAction(currentFilters());
        if (!result.ok) {
          setReportError(result.error ?? "Unknown error");
          return;
        }
        setRows(result.data ?? []);
        return;
      }
      const result = await loadProductSalesPivotAction(currentFilters(), groupBy);
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setPivotSourceRows(result.data ?? []);
    });
  }

  function toggleExpand(sku: string) {
    if (expandedSku === sku) {
      setExpandedSku(null);
      return;
    }
    setExpandedSku(sku);
    if (details[sku]) return;
    startDetailsTransition(async () => {
      const result = await loadSaleLineDetailsAction({ ...currentFilters(), productSku: sku });
      if (result.ok) setDetails((prev) => ({ ...prev, [sku]: result.data ?? [] }));
    });
  }

  function handleExport() {
    const sheet = pivotGrid ? buildPivotSheet(pivotGrid) : rows ? buildFlatReportSheet(rows) : null;
    if (!sheet) return;
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportReportXlsxAction(sheet, "Sales Report");
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      const suffix = groupBy === "none" ? "" : `-by-${groupBy}`;
      downloadBase64File(
        result.data,
        `sales-report${suffix}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
    });
  }

  return (
    <>
      <ReportDescription title="Sales">
        Revenue, COGS, profit, and margin % for every sale — pivotable by location and category, and exportable to
        Excel. Cin7 Core shows sales and costs separately; this pulls both into one view so you can see actual
        profitability per product, category, or location at a glance, not just revenue.
      </ReportDescription>
      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-slate-900">Sales data</p>
            {syncStatus && (
              <p className="mt-1 text-sm text-slate-500">
                {syncStatus.totalSales} sale{syncStatus.totalSales === 1 ? "" : "s"} synced
                {syncStatus.pendingDetail > 0 &&
                  ` — ${syncStatus.pendingDetail} still waiting on line-item detail (rate-limited, catches up a batch every sync run)`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {isSalesStale && <StaleBadge label="Behind — sync recommended" />}
            <button type="button" onClick={handleSync} disabled={isSyncing} className={staleSyncButtonClass(isSalesStale, "sm")}>
              {isSyncing && <Spinner className="mr-1.5" />}
              {isSyncing ? "Syncing…" : "Sync sales now"}
            </button>
          </div>
        </div>
        {syncError && <p className="mt-2 text-sm text-red-600">{syncError}</p>}
        {optionsError && <p className="mt-2 text-sm text-red-600">{optionsError}</p>}
      </section>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Filters</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2 flex flex-col gap-1.5">
              {(options?.instances ?? []).map((inst) => (
                <label key={inst.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={instanceIds.includes(inst.id)} onChange={() => toggleInstance(inst.id)} className="h-4 w-4" />
                  {inst.name}
                </label>
              ))}
              {options && options.instances.length === 0 && <p className="text-sm text-slate-400">No instances connected.</p>}
            </div>
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Location</span>
            <select value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
              <option value="">All locations</option>
              {(options?.locations ?? []).map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Category</span>
            <select
              value={categoryCode}
              onChange={(e) => setCategoryCode(e.target.value)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="">All categories</option>
              {(options?.categories ?? []).map((cat) => (
                <option key={cat.code} value={cat.code}>
                  {cat.name}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">From</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">To</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
          </div>
        </div>

        <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-slate-100 pt-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Group columns by</span>
            <select
              value={groupBy}
              onChange={(e) => setGroupBy(e.target.value as GroupBySelection)}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              <option value="none">None (today&rsquo;s flat table)</option>
              <option value="location">Location</option>
              <option value="category">Category</option>
              <option value="both">Location × Category</option>
            </select>
          </label>

          {groupBy !== "none" && (
            <p className="text-sm text-slate-500">Every metric (Qty/Revenue/COGS/Profit/Margin%) shows together per column.</p>
          )}
        </div>

        <button
          type="button"
          onClick={handleRunReport}
          disabled={isRunning}
          className="mt-5 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {isRunning && <Spinner className="mr-1.5" />}
          {isRunning ? "Running…" : "Run report"}
        </button>

        {reportError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{reportError}</p>}
      </section>

      {rows && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-medium text-slate-900">
              {rows.length} product{rows.length === 1 ? "" : "s"}
            </p>
            {rows.length > 0 && (
              <button
                type="button"
                onClick={handleExport}
                disabled={isExporting}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isExporting ? "Exporting…" : "Export to Excel"}
              </button>
            )}
          </div>
          {exportError && <p className="mt-2 text-sm text-red-600">{exportError}</p>}
          {rows.length === 0 && <p className="mt-2 text-sm text-slate-400">No invoiced sales match these filters.</p>}

          {rows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <SortHeader label="Product" column="product" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Qty sold" column="quantity_sold" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Revenue" column="revenue" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="COGS" column="cogs" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Profit" column="profit" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Margin%" column="margin_percent" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <Fragment key={row.product_sku}>
                      <tr
                        key={row.product_sku}
                        onClick={() => toggleExpand(row.product_sku)}
                        className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                      >
                        <td className="py-2 pr-4">
                          <div className="font-medium text-slate-900">{row.product_name ?? row.product_sku}</div>
                          <div className="text-xs text-slate-400">{row.product_sku}</div>
                        </td>
                        <td className="py-2 pr-4">{row.quantity_sold}</td>
                        <td className="py-2 pr-4">{money(row.revenue)}</td>
                        <td className="py-2 pr-4">{money(row.cogs)}</td>
                        <td className="py-2 pr-4">{money(row.profit)}</td>
                        <td className="py-2 pr-4">{percent(row.margin_percent)}</td>
                      </tr>
                      {expandedSku === row.product_sku && (
                        <InvoiceLineDetail colSpan={6} isLoading={isLoadingDetails} lines={details[row.product_sku]} />
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {pivotGrid && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="font-medium text-slate-900">
              {pivotGrid.rows.length} product{pivotGrid.rows.length === 1 ? "" : "s"} by{" "}
              {groupBy === "both" ? "Location × Category" : groupBy === "location" ? "Location" : "Category"}
            </p>
            {pivotGrid.rows.length > 0 && (
              <button
                type="button"
                onClick={handleExport}
                disabled={isExporting}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isExporting ? "Exporting…" : "Export to Excel"}
              </button>
            )}
          </div>
          {exportError && <p className="mt-2 text-sm text-red-600">{exportError}</p>}
          {pivotGrid.rows.length === 0 && <p className="mt-2 text-sm text-slate-400">No invoiced sales match these filters.</p>}

          {pivotGrid.rows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  {pivotGrid.columnGroups && (
                    <tr className="text-slate-500">
                      <th className="py-1 pr-4" />
                      {pivotGrid.columnGroups.map((group) => (
                        <th
                          key={group.label}
                          colSpan={group.span * METRIC_COLUMNS.length}
                          className="border-b border-slate-100 py-1 pr-4 text-center font-medium"
                        >
                          {group.label}
                        </th>
                      ))}
                      <th colSpan={METRIC_COLUMNS.length} className="border-b border-slate-100 py-1 pr-4" />
                    </tr>
                  )}
                  <tr className="text-slate-500">
                    <th className="py-1 pr-4" />
                    {pivotGrid.columns.map((col) => (
                      <th key={col.key} colSpan={METRIC_COLUMNS.length} className="border-b border-slate-100 py-1 pr-4 text-center font-medium">
                        {col.label}
                      </th>
                    ))}
                    <th colSpan={METRIC_COLUMNS.length} className="border-b border-slate-100 py-1 pr-4 text-center font-semibold">
                      Total
                    </th>
                  </tr>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4">Product</th>
                    {pivotGrid.columns.map((col) => (
                      <MetricHeaderCells key={col.key} />
                    ))}
                    <MetricHeaderCells />
                  </tr>
                </thead>
                <tbody>
                  {pivotGrid.rows.map((row) => (
                    <Fragment key={row.productSku}>
                      <tr
                        onClick={() => toggleExpand(row.productSku)}
                        className="cursor-pointer border-b border-slate-100 hover:bg-slate-50"
                      >
                        <td className="py-2 pr-4">
                          <div className="font-medium text-slate-900">{row.productName}</div>
                          <div className="text-xs text-slate-400">{row.productSku}</div>
                        </td>
                        {pivotGrid.columns.map((col) => (
                          <MetricCells key={col.key} values={row.cells[col.key]} />
                        ))}
                        <MetricCells values={row.total} bold />
                      </tr>
                      {expandedSku === row.productSku && (
                        <InvoiceLineDetail
                          colSpan={1 + (pivotGrid.columns.length + 1) * METRIC_COLUMNS.length}
                          isLoading={isLoadingDetails}
                          lines={details[row.productSku]}
                        />
                      )}
                    </Fragment>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-slate-200 font-semibold text-slate-700">
                    <td className="py-2 pr-4">Total</td>
                    {pivotGrid.columns.map((col) => (
                      <MetricCells key={col.key} values={pivotGrid.totals[col.key]} />
                    ))}
                    <MetricCells values={pivotGrid.grandTotal} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
