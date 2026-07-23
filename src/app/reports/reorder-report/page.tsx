"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import { loadReorderReportAction, loadReorderReportSyncStatusAction, triggerReorderReportSyncAction } from "./actions";
import type { ReportFilterOptions, ReorderReportRow, ProductAvailabilitySyncStatus } from "@/reports/query";
import { SNAPSHOT_STALE_HOURS, hoursSince, StaleBadge, staleSyncButtonClass } from "../sync-staleness";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { Spinner } from "@/app/Spinner";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { ReportDescription } from "../ReportDescription";

type ReorderSortColumn = "product" | "on_hand" | "on_order" | "avg_unit_cost" | "weeks_of_cover" | "reorder_threshold" | "mover_category" | "status";

function reorderSortValue(row: ReorderReportRow, column: ReorderSortColumn): string | number | null {
  if (column === "product") return row.product_name ?? row.product_sku;
  return row[column];
}

type Period = "1m" | "3m" | "6m" | "9m" | "12m";

const PERIOD_OPTIONS: { value: Period; label: string; months: number }[] = [
  { value: "1m", label: "Previous month", months: 1 },
  { value: "3m", label: "Previous 3 months", months: 3 },
  { value: "6m", label: "Previous 6 months", months: 6 },
  { value: "9m", label: "Previous 9 months", months: 9 },
  { value: "12m", label: "Previous 12 months", months: 12 },
];

const BUFFER_OPTIONS = [0, 10, 20, 30];

const MOVER_BADGE: Record<ReorderReportRow["mover_category"], string> = {
  Fast: "bg-emerald-100 text-emerald-700",
  Medium: "bg-amber-100 text-amber-700",
  Slow: "bg-rose-100 text-rose-700",
  "No movement": "bg-slate-100 text-slate-500",
};

const STATUS_BADGE: Record<ReorderReportRow["status"], string> = {
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

function qty(value: number): string {
  return value.toLocaleString();
}

function money(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function ReorderReportPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [period, setPeriod] = useState<Period>("3m");
  const [bufferPercent, setBufferPercent] = useState(10);
  const [needsReorderOnly, setNeedsReorderOnly] = useState(false);

  const [syncStatus, setSyncStatus] = useState<ProductAvailabilitySyncStatus | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);

  const [rows, setRows] = useState<ReorderReportRow[] | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [sortColumn, setSortColumn] = useState<ReorderSortColumn>("weeks_of_cover");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  function handleSort(column: ReorderSortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const visibleRows = useMemo(() => {
    if (!rows) return [];
    return needsReorderOnly ? rows.filter((r) => r.needs_reorder) : rows;
  }, [rows, needsReorderOnly]);

  const sortedRows = useMemo(() => {
    const copy = [...visibleRows];
    copy.sort((a, b) => {
      const cmp = compareNullable(reorderSortValue(a, sortColumn), reorderSortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [visibleRows, sortColumn, sortDirection]);

  function refreshOptionsAndStatus() {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
    loadReorderReportSyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
  }

  useEffect(() => {
    refreshOptionsAndStatus();
  }, []);

  // Keeps an ALREADY-shown report in sync when the instance selection
  // changes — same fix already applied to Stock Health/Order Fulfillment/
  // Shipping Calendar. Period and buffer % stay manual-apply via Run report.
  useEffect(() => {
    if (rows === null) return;
    const months = PERIOD_OPTIONS.find((p) => p.value === period)!.months;
    loadReorderReportAction({
      instanceIds: instanceIds.length ? instanceIds : undefined,
      velocityDateFrom: monthsAgoIso(months),
      velocityDateTo: todayIso(),
      bufferPercent,
    }).then((result) => {
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setReportError(null);
      setRows(result.data ?? []);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately scoped to instanceIds only; period/buffer stay manual-apply via Run report
  }, [instanceIds]);

  function handleSync() {
    setSyncError(null);
    startSyncTransition(async () => {
      const result = await triggerReorderReportSyncAction();
      if (!result.ok) {
        setSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshOptionsAndStatus();
    });
  }

  const isStockStale = Boolean(syncStatus) && (!syncStatus?.lastSyncedAt || hoursSince(syncStatus.lastSyncedAt) > SNAPSHOT_STALE_HOURS);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleRunReport() {
    setReportError(null);
    setRows(null);
    const months = PERIOD_OPTIONS.find((p) => p.value === period)!.months;
    startRunTransition(async () => {
      const result = await loadReorderReportAction({
        instanceIds: instanceIds.length ? instanceIds : undefined,
        velocityDateFrom: monthsAgoIso(months),
        velocityDateTo: todayIso(),
        bufferPercent,
      });
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setRows(result.data ?? []);
    });
  }

  const needsReorderCount = rows ? rows.filter((r) => r.needs_reorder).length : 0;

  return (
    <>
      <ReportDescription title="Reorder Report">
        Flags a product once its on-hand stock has dropped to or below its recent sales over the selected period plus a
        buffer % — the simple, threshold-based reorder check for suppliers with no meaningful lead time to plan around.
        For imports/long-lead-time suppliers, use the Supplier Planner instead. Stock levels are a live snapshot —
        refresh them below before running the report if you need the latest numbers.
      </ReportDescription>

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
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2">
              {options && <InstanceMultiPicker instances={options.instances} selectedIds={instanceIds} onToggle={toggleInstance} />}
            </div>
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Sales period</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="rounded-lg border border-slate-300 px-3 py-2">
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Buffer</span>
            <select
              value={bufferPercent}
              onChange={(e) => setBufferPercent(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              {BUFFER_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  +{b}%
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
                {visibleRows.length} product{visibleRows.length === 1 ? "" : "s"}
              </p>
              <p className="mt-1 text-sm text-slate-500">{needsReorderCount} need reordering at this buffer</p>
            </div>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={needsReorderOnly} onChange={(e) => setNeedsReorderOnly(e.target.checked)} />
              Needs reorder only
            </label>
          </div>
          {visibleRows.length === 0 && <p className="mt-2 text-sm text-slate-400">No stock or movement data matches these filters.</p>}

          {visibleRows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <SortHeader label="Product" column="product" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Weeks of Stock" column="weeks_of_cover" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Qty on Hand" column="on_hand" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="On Order" column="on_order" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Reorder At" column="reorder_threshold" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Avg Unit Cost" column="avg_unit_cost" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Mover" column="mover_category" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Status" column="status" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={row.product_sku} className={`border-b border-slate-100 ${row.needs_reorder ? "bg-amber-50/50" : ""}`}>
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-900">{row.product_name ?? row.product_sku}</div>
                        <div className="text-xs text-slate-400">{row.product_sku}</div>
                      </td>
                      <td className="py-2 pr-4 text-right">{row.weeks_of_cover ?? "—"}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.on_hand)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.on_order)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.reorder_threshold)}</td>
                      <td className="py-2 pr-4 text-right">{money(row.avg_unit_cost)}</td>
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
