"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import {
  loadStockHealthReportAction,
  exportStockHealthXlsxAction,
  loadProductAvailabilitySyncStatusAction,
  triggerProductAvailabilitySyncAction,
} from "./actions";
import type { ReportFilterOptions, StockHealthRow, ProductAvailabilitySyncStatus } from "@/reports/query";
import { SNAPSHOT_STALE_HOURS, hoursSince, StaleBadge, staleSyncButtonClass } from "../sync-staleness";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { ReportDescription } from "../ReportDescription";

type StockHealthSortColumn = "product" | "on_hand" | "available" | "stock_value" | "total_out" | "days_of_cover" | "mover_category" | "status";

function stockHealthSortValue(row: StockHealthRow, column: StockHealthSortColumn): string | number | null {
  if (column === "product") return row.product_name ?? row.product_sku;
  return row[column];
}

type Period = "1m" | "3m" | "6m" | "12m";

const PERIOD_OPTIONS: { value: Period; label: string; months: number }[] = [
  { value: "1m", label: "Previous month", months: 1 },
  { value: "3m", label: "Previous 3 months", months: 3 },
  { value: "6m", label: "Previous 6 months", months: 6 },
  { value: "12m", label: "Previous 12 months", months: 12 },
];

const MOVER_BADGE: Record<StockHealthRow["mover_category"], string> = {
  Fast: "bg-emerald-100 text-emerald-700",
  Medium: "bg-amber-100 text-amber-700",
  Slow: "bg-rose-100 text-rose-700",
  "No movement": "bg-slate-100 text-slate-500",
};

const STATUS_BADGE: Record<StockHealthRow["status"], string> = {
  "Stockout risk": "bg-rose-100 text-rose-700",
  Excess: "bg-amber-100 text-amber-700",
  Healthy: "bg-emerald-100 text-emerald-700",
};

/** "YYYY-MM-DD" for today minus N months, in local time — matches the date-only columns this report filters against. */
function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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

export default function StockHealthPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [period, setPeriod] = useState<Period>("3m");

  const [syncStatus, setSyncStatus] = useState<ProductAvailabilitySyncStatus | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);

  const [rows, setRows] = useState<StockHealthRow[] | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const [sortColumn, setSortColumn] = useState<StockHealthSortColumn>("stock_value");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  function handleSort(column: StockHealthSortColumn) {
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
      const cmp = compareNullable(stockHealthSortValue(a, sortColumn), stockHealthSortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortColumn, sortDirection]);

  function refreshOptionsAndStatus() {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
    loadProductAvailabilitySyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
  }

  useEffect(() => {
    refreshOptionsAndStatus();
  }, []);

  // Keeps an ALREADY-shown report in sync when the instance selection
  // changes, rather than letting it silently go stale until "Run report" is
  // clicked again — matches the fix already applied to Order Fulfillment/
  // Shipping Calendar (2026-07-10). Skips entirely if no report has been
  // generated yet, since every other filter here (period) still stays
  // manual-apply via Run report; an instance toggle is the one exception.
  useEffect(() => {
    if (rows === null) return;
    const months = PERIOD_OPTIONS.find((p) => p.value === period)!.months;
    loadStockHealthReportAction({
      instanceIds: instanceIds.length ? instanceIds : undefined,
      velocityDateFrom: monthsAgoIso(months),
      velocityDateTo: todayIso(),
    }).then((result) => {
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setReportError(null);
      setRows(result.data ?? []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately scoped to instanceIds only; period stays manual-apply via Run report
  }, [instanceIds]);

  function handleSync() {
    setSyncError(null);
    startSyncTransition(async () => {
      const result = await triggerProductAvailabilitySyncAction();
      if (!result.ok) {
        setSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshOptionsAndStatus();
    });
  }

  // Full snapshot-replace sync (see sync-product-availability.ts) — stale once too much time has passed since the one "last synced" timestamp, not a pending-count signal.
  const isStockStale = Boolean(syncStatus) && (!syncStatus?.lastSyncedAt || hoursSince(syncStatus.lastSyncedAt) > SNAPSHOT_STALE_HOURS);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleRunReport() {
    setReportError(null);
    setRows(null);
    const months = PERIOD_OPTIONS.find((p) => p.value === period)!.months;
    startRunTransition(async () => {
      const result = await loadStockHealthReportAction({
        instanceIds: instanceIds.length ? instanceIds : undefined,
        velocityDateFrom: monthsAgoIso(months),
        velocityDateTo: todayIso(),
      });
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setRows(result.data ?? []);
    });
  }

  function handleExport() {
    if (!rows) return;
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportStockHealthXlsxAction(rows);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "stock-health-report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  const summary = rows
    ? {
        stockoutRisk: rows.filter((r) => r.status === "Stockout risk").length,
        excess: rows.filter((r) => r.status === "Excess").length,
        healthy: rows.filter((r) => r.status === "Healthy").length,
      }
    : null;

  return (
    <>
      <ReportDescription title="Stock Health">
        Combines current stock levels with how fast each product actually sells or gets consumed to show what Cin7&rsquo;s
        own stock screen doesn&rsquo;t: days of cover per product, and which stock is either at risk of running out or
        just sitting there tying up capital. Stock levels are a live snapshot — refresh them below before running the
        report if you need the latest numbers.
      </ReportDescription>
      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-medium text-slate-900">Stock levels</p>
            {syncStatus && (
              <p className="mt-1 text-sm text-slate-500">
                {syncStatus.totalRows.toLocaleString()} row{syncStatus.totalRows === 1 ? "" : "s"} synced
                {syncStatus.lastSyncedAt && ` — last refreshed ${new Date(syncStatus.lastSyncedAt).toLocaleString()}`}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3">
            {isStockStale && <StaleBadge label="Stale — sync recommended" />}
            <button type="button" onClick={handleSync} disabled={isSyncing} className={staleSyncButtonClass(isStockStale, "sm")}>
              {isSyncing && <Spinner className="mr-1.5" />}
              {isSyncing ? "Syncing…" : "Sync stock levels now"}
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
            <div className="mt-2">
              {options && <InstanceMultiPicker instances={options.instances} selectedIds={instanceIds} onToggle={toggleInstance} />}
            </div>
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Velocity lookback</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="rounded-lg border border-slate-300 px-3 py-2">
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
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
            <div>
              <p className="font-medium text-slate-900">
                {rows.length} product{rows.length === 1 ? "" : "s"}
              </p>
              {summary && (
                <p className="mt-1 text-sm text-slate-500">
                  {summary.stockoutRisk} stockout risk, {summary.excess} excess, {summary.healthy} healthy
                </p>
              )}
            </div>
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
          {rows.length === 0 && <p className="mt-2 text-sm text-slate-400">No stock or movement data matches these filters.</p>}

          {rows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <SortHeader label="Product" column="product" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="On Hand" column="on_hand" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Available" column="available" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Stock Value"
                      column="stock_value"
                      align="right"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader label="Total Out" column="total_out" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Days of Cover"
                      column="days_of_cover"
                      align="right"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader label="Mover" column="mover_category" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Status" column="status" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={row.product_sku} className="border-b border-slate-100">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-900">{row.product_name ?? row.product_sku}</div>
                        <div className="text-xs text-slate-400">{row.product_sku}</div>
                      </td>
                      <td className="py-2 pr-4 text-right">{qty(row.on_hand)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.available)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.stock_value)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.total_out)}</td>
                      <td className="py-2 pr-4 text-right">{row.days_of_cover ?? "—"}</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${MOVER_BADGE[row.mover_category]}`}>
                          {row.mover_category}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[row.status]}`}>{row.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
