"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import { loadInventoryMovementReportAction, exportInventoryMovementXlsxAction } from "./actions";
import type { ReportFilterOptions } from "@/reports/query";
import type { InventoryMovementRow } from "@/reports/query";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { matchesSearch } from "../text-search";
import { SearchInput } from "../search-input";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { ReportDescription } from "../ReportDescription";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";

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

const MOVER_TONE: Record<InventoryMovementRow["mover_category"], BadgeTone> = {
  Fast: "success",
  Medium: "warning",
  Slow: "danger",
  "No movement": "neutral",
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
  const [search, setSearch] = useState("");

  function handleSort(column: MovementSortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  // P5.4 (LBL brief): filters by product SKU or name.
  const filteredRows = useMemo(() => (rows ?? []).filter((r) => matchesSearch(search, r.product_sku, r.product_name)), [rows, search]);

  const sortedRows = useMemo(() => {
    if (!rows) return [];
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      const cmp = compareNullable(movementSortValue(a, sortColumn), movementSortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [rows, filteredRows, sortColumn, sortDirection]);

  useEffect(() => {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
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
    loadInventoryMovementReportAction({
      instanceIds: instanceIds.length ? instanceIds : undefined,
      dateFrom: monthsAgoIso(months),
      dateTo: todayIso(),
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
      const result = await exportInventoryMovementXlsxAction(filteredRows);
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

      <Panel>
        <PanelTitle>Filters</PanelTitle>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2">
              {options && <InstanceMultiPicker instances={options.instances} selectedIds={instanceIds} onToggle={toggleInstance} />}
            </div>
          </div>

          <Select label="Period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIOD_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>

          <SearchInput value={search} onChange={setSearch} placeholder="Product name or SKU" />
        </div>

        <div className="mt-5">
          <Button onClick={handleRunReport} loading={isRunning}>
            {isRunning ? "Running…" : "Run report"}
          </Button>
        </div>

        {reportError && (
          <div className="mt-4">
            <Alert tone="danger">{reportError}</Alert>
          </div>
        )}
        {optionsError && (
          <div className="mt-2">
            <Alert tone="danger">{optionsError}</Alert>
          </div>
        )}
      </Panel>

      {rows && (
        <Panel className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-base font-semibold text-slate-900">
                {filteredRows.length} product{filteredRows.length === 1 ? "" : "s"}
              </p>
              {summary && (
                <p className="mt-1 text-sm text-slate-500">
                  {summary.fast} fast, {summary.medium} medium, {summary.slow} slow, {summary.none} no movement
                </p>
              )}
            </div>
            {filteredRows.length > 0 && (
              <Button variant="secondary" size="sm" onClick={handleExport} loading={isExporting}>
                {isExporting ? "Exporting…" : "Export to Excel"}
              </Button>
            )}
          </div>
          {exportError && (
            <div className="mt-2">
              <Alert tone="danger">{exportError}</Alert>
            </div>
          )}
          {rows.length === 0 && (
            <div className="mt-2">
              <EmptyState title="No inventory movement" description="No inventory movement in this period." />
            </div>
          )}
          {rows.length > 0 && filteredRows.length === 0 && <p className="mt-2 text-sm text-slate-500">Nothing matches &ldquo;{search}&rdquo;.</p>}

          {filteredRows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50">
                  <tr className="border-b-2 border-slate-300 text-slate-600">
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
                    <tr key={row.product_sku} className="border-b border-slate-100 hover:bg-slate-50">
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-900">{row.product_name ?? row.product_sku}</div>
                        <div className="font-mono text-xs text-slate-500">{row.product_sku}</div>
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{qty(row.qty_in_purchases)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{qty(row.qty_in_assemblies)}</td>
                      <td className="py-2 pr-4 text-right font-medium tabular-nums">{qty(row.total_in)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{qty(row.qty_out_sales)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{qty(row.qty_out_consumption)}</td>
                      <td className="py-2 pr-4 text-right font-medium tabular-nums">{qty(row.total_out)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{qty(row.net_change)}</td>
                      <td className="py-2 pr-4">
                        <Badge tone={MOVER_TONE[row.mover_category]}>{row.mover_category}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
