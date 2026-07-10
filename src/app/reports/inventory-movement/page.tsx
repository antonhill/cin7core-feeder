"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import { loadInventoryMovementReportAction, exportInventoryMovementXlsxAction } from "./actions";
import type { ReportFilterOptions } from "@/reports/query";
import type { InventoryMovementRow } from "@/reports/query";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "../ReportDescription";

type MovementSortColumn =
  | "product"
  | "qty_in_purchases"
  | "qty_in_assemblies"
  | "total_in"
  | "qty_out_sales"
  | "qty_out_consumption"
  | "total_out"
  | "net_change"
  | "mover_category";

function movementSortValue(row: InventoryMovementRow, column: MovementSortColumn): string | number | null {
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

const MOVER_BADGE: Record<InventoryMovementRow["mover_category"], string> = {
  Fast: "bg-emerald-100 text-emerald-700",
  Medium: "bg-amber-100 text-amber-700",
  Slow: "bg-rose-100 text-rose-700",
  "No movement": "bg-slate-100 text-slate-500",
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

export default function InventoryMovementPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [period, setPeriod] = useState<Period>("3m");

  const [rows, setRows] = useState<InventoryMovementRow[] | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const [sortColumn, setSortColumn] = useState<MovementSortColumn>("total_out");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  function handleSort(column: MovementSortColumn) {
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
      const cmp = compareNullable(movementSortValue(a, sortColumn), movementSortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, sortColumn, sortDirection]);

  useEffect(() => {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
  }, []);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleRunReport() {
    setReportError(null);
    setRows(null);
    const months = PERIOD_OPTIONS.find((p) => p.value === period)!.months;
    startRunTransition(async () => {
      const result = await loadInventoryMovementReportAction({
        instanceIds: instanceIds.length ? instanceIds : undefined,
        dateFrom: monthsAgoIso(months),
        dateTo: todayIso(),
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
      const result = await exportInventoryMovementXlsxAction(rows);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "inventory-movement-report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  const summary = rows
    ? {
        fast: rows.filter((r) => r.mover_category === "Fast").length,
        medium: rows.filter((r) => r.mover_category === "Medium").length,
        slow: rows.filter((r) => r.mover_category === "Slow").length,
        none: rows.filter((r) => r.mover_category === "No movement").length,
      }
    : null;

  return (
    <>
      <ReportDescription title="Inventory Movement">
        Tracks how much of each product moved in (purchases received + assemblies built) and out (sales + components
        consumed building other assemblies) over a period you choose, and classifies every product as a Fast, Medium,
        or Slow mover based on how much of it actually sold or was consumed — so you can see at a glance what to
        reorder and what&rsquo;s just sitting there.
      </ReportDescription>
      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
            <span className="font-medium text-slate-700">Period</span>
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
        {optionsError && <p className="mt-2 text-sm text-red-600">{optionsError}</p>}
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
                  {summary.fast} fast, {summary.medium} medium, {summary.slow} slow, {summary.none} no movement
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
          {rows.length === 0 && <p className="mt-2 text-sm text-slate-400">No inventory movement in this period.</p>}

          {rows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <SortHeader label="Product" column="product" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Purchased In"
                      column="qty_in_purchases"
                      align="right"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label="Assembly In"
                      column="qty_in_assemblies"
                      align="right"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader label="Total In" column="total_in" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Sold Out"
                      column="qty_out_sales"
                      align="right"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label="Consumed Out"
                      column="qty_out_consumption"
                      align="right"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader label="Total Out" column="total_out" align="right" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Net Change"
                      column="net_change"
                      align="right"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader label="Mover" column="mover_category" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  </tr>
                </thead>
                <tbody>
                  {sortedRows.map((row) => (
                    <tr key={row.product_sku} className="border-b border-slate-100">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-900">{row.product_name ?? row.product_sku}</div>
                        <div className="text-xs text-slate-400">{row.product_sku}</div>
                      </td>
                      <td className="py-2 pr-4 text-right">{qty(row.qty_in_purchases)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.qty_in_assemblies)}</td>
                      <td className="py-2 pr-4 text-right font-medium">{qty(row.total_in)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.qty_out_sales)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.qty_out_consumption)}</td>
                      <td className="py-2 pr-4 text-right font-medium">{qty(row.total_out)}</td>
                      <td className="py-2 pr-4 text-right">{qty(row.net_change)}</td>
                      <td className="py-2 pr-4">
                        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${MOVER_BADGE[row.mover_category]}`}>
                          {row.mover_category}
                        </span>
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
