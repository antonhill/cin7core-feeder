"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import {
  loadReorderReportAction,
  loadReorderReportSyncStatusAction,
  triggerReorderReportSyncAction,
  exportReorderReportXlsxAction,
  loadReorderReportSupplierLinesAction,
  createReorderReportPurchaseOrdersAction,
  exportReorderReportSupplierLinesXlsxAction,
  type CreatedPurchaseOrder,
  type FailedPurchaseOrder,
} from "./actions";
import type { ReportFilterOptions, ReorderReportRow, ProductAvailabilitySyncStatus } from "@/reports/query";
import { SNAPSHOT_STALE_HOURS, hoursSince, StaleBadge, staleSyncButtonClass } from "../sync-staleness";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { Spinner } from "@/app/Spinner";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { ReportDescription } from "../ReportDescription";
import { getBillingStatusAction } from "@/actions/billing";
import { groupLinesBySupplier, type SupplierPlanLine } from "@/reports/supplier-planner/build";
import type { Cin7Location } from "@/cin7/reference-lookups";

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

const MOVER_OPTIONS: ReorderReportRow["mover_category"][] = ["Fast", "Medium", "Slow", "No movement"];
const STATUS_OPTIONS: ReorderReportRow["status"][] = ["Stockout risk", "Excess", "Healthy"];

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

function lineKey(line: SupplierPlanLine): string {
  return `${line.productSku}::${line.supplierId}::${line.locationId ?? "default"}`;
}

/** Cin7's own supplier Currency field — the closest signal this app has to "local vs foreign" supplier. */
function currencyLabel(line: SupplierPlanLine): string {
  return line.currency ?? "No currency";
}

function lineMoney(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  return `${currency ?? ""} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

const FILTER_PREVIEW_COUNT = 8;

/** A checkbox filter group that collapses to a short preview when the option list is long — same component as Purchase Planner's, duplicated rather than shared since it's small and the two pages don't otherwise share UI code. */
function CollapsibleCheckboxFilter({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = options.length > FILTER_PREVIEW_COUNT;
  const visible = expanded ? options : options.slice(0, FILTER_PREVIEW_COUNT);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</span>
        <button type="button" onClick={onClear} className="text-xs text-indigo-600 hover:underline">
          Clear{selected.length > 0 ? ` (${selected.length})` : ""}
        </button>
      </div>
      <div className="flex max-w-2xl flex-wrap items-center gap-3">
        {visible.map((value) => (
          <label key={value} className="flex items-center gap-1.5 text-sm text-slate-700">
            <input type="checkbox" checked={selected.includes(value)} onChange={() => onToggle(value)} />
            {value}
          </label>
        ))}
      </div>
      {hasMore && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="self-start text-xs text-indigo-600 hover:underline">
          {expanded ? "Show less" : `Show all (${options.length})`}
        </button>
      )}
    </div>
  );
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

  // "No movement" starts unchecked — a SKU with zero sales in the whole
  // selected period trivially satisfies on_hand(0) <= reorder_threshold(0)
  // and gets flagged needs_reorder regardless of any real velocity signal.
  // Reusing this existing Mover filter to hide/reveal them (rather than a
  // separate toggle) avoids two overlapping controls doing the same thing.
  const [moverFilter, setMoverFilter] = useState<Set<ReorderReportRow["mover_category"]>>(
    new Set(MOVER_OPTIONS.filter((m) => m !== "No movement"))
  );
  const [statusFilter, setStatusFilter] = useState<Set<ReorderReportRow["status"]>>(new Set(STATUS_OPTIONS));

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const [sortColumn, setSortColumn] = useState<ReorderSortColumn>("weeks_of_cover");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  // Supplier fan-out + PO creation (2026-07-27) — a live Cin7 supplier fetch,
  // so deliberately a manual "Load supplier data" action rather than
  // auto-triggered, same discipline as Purchase Planner's own "Run plan".
  // Requires exactly one instance selected: a supplier fetch and a Purchase
  // Order write are inherently single-instance, unlike the plain report
  // above which can aggregate several.
  const [canWrite, setCanWrite] = useState(true);
  const [supplierLines, setSupplierLines] = useState<SupplierPlanLine[] | null>(null);
  const [supplierLocations, setSupplierLocations] = useState<Cin7Location[]>([]);
  const [supplierError, setSupplierError] = useState<string | null>(null);
  const [isLoadingSuppliers, startLoadSuppliersTransition] = useTransition();
  const [receivingLocationId, setReceivingLocationId] = useState("");

  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState<string[]>([]);
  const [brandFilter, setBrandFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [currencyFilter, setCurrencyFilter] = useState<Set<string> | null>(null);

  const [rawExcludedLineKeys, setRawExcludedLineKeys] = useState<Set<string>>(new Set());
  const [creatingSupplier, setCreatingSupplier] = useState<string | null>(null);
  const [isCreatingPo, startCreatePoTransition] = useTransition();
  const [poResults, setPoResults] = useState<Map<string, { created: CreatedPurchaseOrder[]; failed: FailedPurchaseOrder[]; error?: string }>>(new Map());

  const [isExportingSuppliers, startExportSuppliersTransition] = useTransition();
  const [exportSuppliersError, setExportSuppliersError] = useState<string | null>(null);

  useEffect(() => {
    getBillingStatusAction().then((res) => {
      if (res.ok && res.data) setCanWrite(res.data.canWrite);
    });
  }, []);

  function toggleMover(m: ReorderReportRow["mover_category"]) {
    setMoverFilter((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }

  function toggleStatus(s: ReorderReportRow["status"]) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  function handleSort(column: ReorderSortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const visibleRows = useMemo(() => {
    if (!rows) return [];
    return rows.filter(
      (r) => (!needsReorderOnly || r.needs_reorder) && moverFilter.has(r.mover_category) && statusFilter.has(r.status)
    );
  }, [rows, needsReorderOnly, moverFilter, statusFilter]);

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
      // Instance selection changing invalidates any already-loaded supplier
      // data (it's fetched live against exactly one instance) — force a
      // fresh, explicit "Load supplier data" rather than showing stale lines.
      setSupplierLines(null);
      setSupplierError(null);
      setPoResults(new Map());
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
    setSupplierLines(null);
    setSupplierError(null);
    setPoResults(new Map());
    setRawExcludedLineKeys(new Set());
    setReceivingLocationId("");
    setCurrencyFilter(null);
    setSearch("");
    setSupplierFilter([]);
    setBrandFilter([]);
    setCategoryFilter([]);
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

  function handleLoadSuppliers() {
    if (instanceIds.length !== 1) return;
    setSupplierError(null);
    setSupplierLines(null);
    setPoResults(new Map());
    startLoadSuppliersTransition(async () => {
      const result = await loadReorderReportSupplierLinesAction(instanceIds[0], visibleRows);
      if (!result.ok) {
        setSupplierError(result.error ?? "Unknown error");
        return;
      }
      const newLines = result.data?.lines ?? [];
      setSupplierLines(newLines);
      setSupplierLocations(result.data?.locations ?? []);
      // Default-deselect anything already covered by a draft PO awaiting
      // authorization in Cin7 — avoids accidentally creating a duplicate.
      setRawExcludedLineKeys(new Set(newLines.filter((l) => l.pendingPurchaseOrder).map(lineKey)));
    });
  }

  const availableCurrencies = useMemo(() => [...new Set((supplierLines ?? []).map(currencyLabel))].sort(), [supplierLines]);
  const availableSuppliers = useMemo(() => [...new Set((supplierLines ?? []).map((l) => l.supplierName))].sort(), [supplierLines]);
  const availableBrands = useMemo(
    () => [...new Set((supplierLines ?? []).map((l) => l.brand).filter((b): b is string => b !== null))].sort(),
    [supplierLines]
  );
  const availableCategories = useMemo(
    () => [...new Set((supplierLines ?? []).map((l) => l.category).filter((c): c is string => c !== null))].sort(),
    [supplierLines]
  );

  function toggleCurrency(currency: string) {
    setCurrencyFilter((prev) => {
      const next = new Set(prev ?? availableCurrencies);
      if (next.has(currency)) next.delete(currency);
      else next.add(currency);
      return next;
    });
  }
  function toggleSupplierFilter(supplier: string) {
    setSupplierFilter((prev) => (prev.includes(supplier) ? prev.filter((s) => s !== supplier) : [...prev, supplier]));
  }
  function toggleBrandFilter(brand: string) {
    setBrandFilter((prev) => (prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]));
  }
  function toggleCategoryFilter(category: string) {
    setCategoryFilter((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  const visibleSupplierLines = useMemo(() => {
    if (!supplierLines) return [];
    const needle = search.trim().toLowerCase();
    return supplierLines.filter(
      (l) =>
        (currencyFilter === null || currencyFilter.has(currencyLabel(l))) &&
        (supplierFilter.length === 0 || supplierFilter.includes(l.supplierName)) &&
        (brandFilter.length === 0 || (l.brand !== null && brandFilter.includes(l.brand))) &&
        (categoryFilter.length === 0 || (l.category !== null && categoryFilter.includes(l.category))) &&
        (!needle ||
          l.productSku.toLowerCase().includes(needle) ||
          l.productName.toLowerCase().includes(needle) ||
          l.supplierName.toLowerCase().includes(needle))
    );
  }, [supplierLines, currencyFilter, supplierFilter, brandFilter, categoryFilter, search]);

  const groupedSupplierLines = useMemo(() => groupLinesBySupplier(visibleSupplierLines), [visibleSupplierLines]);

  const excludedLineKeys = useMemo(() => {
    const visibleKeys = new Set(visibleSupplierLines.map(lineKey));
    return new Set([...rawExcludedLineKeys].filter((k) => visibleKeys.has(k)));
  }, [rawExcludedLineKeys, visibleSupplierLines]);

  function toggleLine(key: string) {
    setRawExcludedLineKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSupplierLines(lines: SupplierPlanLine[]) {
    const keys = lines.map(lineKey);
    const allSelected = keys.every((k) => !excludedLineKeys.has(k));
    setRawExcludedLineKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => (allSelected ? next.add(k) : next.delete(k)));
      return next;
    });
  }

  const receivingLocation = supplierLocations.find((l) => l.id === receivingLocationId);

  function handleCreatePo(supplierName: string, lines: SupplierPlanLine[]) {
    if (instanceIds.length !== 1) return;
    const selected = lines.filter((l) => !excludedLineKeys.has(lineKey(l)));
    if (!selected.length) return;
    setCreatingSupplier(supplierName);
    startCreatePoTransition(async () => {
      const result = await createReorderReportPurchaseOrdersAction(
        instanceIds[0],
        selected,
        receivingLocation ? { locationId: receivingLocation.id, locationName: receivingLocation.name } : undefined
      );
      setPoResults((prev) => {
        const next = new Map(prev);
        if (result.data) next.set(supplierName, { created: result.data.created, failed: result.data.failed });
        else next.set(supplierName, { created: [], failed: [], error: result.error ?? "Unknown error" });
        return next;
      });
      setCreatingSupplier(null);
    });
  }

  function handleExportSuppliers() {
    if (!visibleSupplierLines.length) return;
    setExportSuppliersError(null);
    startExportSuppliersTransition(async () => {
      const result = await exportReorderReportSupplierLinesXlsxAction(visibleSupplierLines);
      if (!result.ok || !result.data) {
        setExportSuppliersError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "reorder-report-suppliers.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  const needsReorderCount = rows ? rows.filter((r) => r.needs_reorder).length : 0;
  const noMovementCount = rows ? rows.filter((r) => r.mover_category === "No movement").length : 0;

  function handleExport() {
    if (!visibleRows.length) return;
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportReorderReportXlsxAction(visibleRows);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "reorder-report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  return (
    <>
      <ReportDescription title="Reorder Report">
        Flags a product once its on-hand stock has dropped to or below its recent sales over the selected period plus a
        buffer % — the simple, threshold-based reorder check for suppliers with no meaningful lead time to plan around.
        For imports/long-lead-time suppliers, use the Purchase Planner instead. Stock levels are a live snapshot —
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
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={needsReorderOnly} onChange={(e) => setNeedsReorderOnly(e.target.checked)} />
                Needs reorder only
              </label>
              <button
                type="button"
                onClick={handleExport}
                disabled={isExporting || visibleRows.length === 0}
                className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isExporting && <Spinner className="mr-1.5" />}
                {isExporting ? "Exporting…" : "Export to Excel"}
              </button>
            </div>
          </div>

          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Mover</span>
              {MOVER_OPTIONS.map((m) => (
                <label key={m} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="checkbox" checked={moverFilter.has(m)} onChange={() => toggleMover(m)} />
                  {m}
                  {m === "No movement" && !moverFilter.has(m) && noMovementCount > 0 && (
                    <span className="text-slate-400">({noMovementCount} hidden)</span>
                  )}
                </label>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Status</span>
              {STATUS_OPTIONS.map((s) => (
                <label key={s} className="flex items-center gap-1.5 text-sm text-slate-700">
                  <input type="checkbox" checked={statusFilter.has(s)} onChange={() => toggleStatus(s)} />
                  {s}
                </label>
              ))}
            </div>
          </div>

          {exportError && <p className="mt-2 text-sm text-red-600">{exportError}</p>}
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

      {rows && (
        <section className="mt-6 flex flex-col gap-6">
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="font-medium text-slate-900">Suppliers &amp; purchase orders</p>
            {instanceIds.length !== 1 ? (
              <p className="mt-2 text-sm text-slate-500">
                Select exactly one instance above to load live supplier data and create Purchase Orders — a supplier
                fetch and a PO write are inherently single-instance in Cin7.
              </p>
            ) : (
              supplierLines === null && (
                <>
                  <p className="mt-2 max-w-2xl text-sm text-slate-500">
                    Fetches this instance&apos;s live supplier data (MOQ, currency, cost) for the {visibleRows.length} product
                    {visibleRows.length === 1 ? "" : "s"} currently shown above, and lets you create draft Purchase Orders for
                    whichever ones need reordering.
                  </p>
                  <button
                    type="button"
                    onClick={handleLoadSuppliers}
                    disabled={isLoadingSuppliers || visibleRows.length === 0}
                    className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {isLoadingSuppliers && <Spinner className="mr-1.5" />}
                    {isLoadingSuppliers ? "Loading suppliers…" : "Load supplier data"}
                  </button>
                  {supplierError && (
                    <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{supplierError}</p>
                  )}
                </>
              )
            )}
          </div>

          {supplierLines !== null && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <p className="text-sm text-slate-500">
                  {visibleSupplierLines.length} line{visibleSupplierLines.length === 1 ? "" : "s"} across {groupedSupplierLines.size}{" "}
                  supplier{groupedSupplierLines.size === 1 ? "" : "s"}
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search product, SKU, or supplier…"
                    className="w-64 rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
                  />
                  <button
                    type="button"
                    onClick={handleLoadSuppliers}
                    disabled={isLoadingSuppliers}
                    className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {isLoadingSuppliers && <Spinner className="mr-1.5" />}
                    {isLoadingSuppliers ? "Reloading…" : "Reload supplier data"}
                  </button>
                  <button
                    type="button"
                    onClick={handleExportSuppliers}
                    disabled={isExportingSuppliers || visibleSupplierLines.length === 0}
                    className="rounded-full border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {isExportingSuppliers && <Spinner className="mr-1.5" />}
                    {isExportingSuppliers ? "Exporting…" : "Export to Excel"}
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                <label className="flex flex-col gap-1.5 text-sm">
                  <span className="font-medium text-slate-700">Receiving location</span>
                  <select
                    value={receivingLocationId}
                    onChange={(e) => setReceivingLocationId(e.target.value)}
                    className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                  >
                    <option value="">Choose a location…</option>
                    {supplierLocations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="max-w-md text-xs text-slate-400">
                  Every line here needs a receiving location — this report has no per-location supplier data, so Cin7
                  needs exactly one chosen up front for any PO created below.
                </p>
              </div>

              {(availableSuppliers.length > 0 || availableBrands.length > 0 || availableCategories.length > 0 || availableCurrencies.length > 0) && (
                <div className="flex flex-wrap gap-x-6 gap-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
                  {availableSuppliers.length > 0 && (
                    <CollapsibleCheckboxFilter
                      label="Supplier"
                      options={availableSuppliers}
                      selected={supplierFilter}
                      onToggle={toggleSupplierFilter}
                      onClear={() => setSupplierFilter([])}
                    />
                  )}
                  {availableBrands.length > 0 && (
                    <CollapsibleCheckboxFilter
                      label="Brand"
                      options={availableBrands}
                      selected={brandFilter}
                      onToggle={toggleBrandFilter}
                      onClear={() => setBrandFilter([])}
                    />
                  )}
                  {availableCategories.length > 0 && (
                    <CollapsibleCheckboxFilter
                      label="Category"
                      options={availableCategories}
                      selected={categoryFilter}
                      onToggle={toggleCategoryFilter}
                      onClear={() => setCategoryFilter([])}
                    />
                  )}
                  {availableCurrencies.length > 0 && (
                    <div className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium uppercase tracking-wide text-slate-400">Currency</span>
                      <div className="flex flex-wrap items-center gap-3">
                        {availableCurrencies.map((c) => (
                          <label key={c} className="flex items-center gap-1.5 text-sm text-slate-700">
                            <input type="checkbox" checked={currencyFilter === null || currencyFilter.has(c)} onChange={() => toggleCurrency(c)} />
                            {c}
                          </label>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              {exportSuppliersError && <p className="text-sm text-red-600">{exportSuppliersError}</p>}

              {visibleSupplierLines.length === 0 && (
                <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-400 shadow-sm">
                  No products with a configured supplier match these filters.
                </p>
              )}

              {[...groupedSupplierLines.entries()].map(([supplierName, groupLines]) => {
                const selectedLines = groupLines.filter((l) => !excludedLineKeys.has(lineKey(l)));
                const selectedCount = selectedLines.length;
                const allSelected = selectedCount === groupLines.length;
                const poResult = poResults.get(supplierName);
                const isCreatingThisSupplier = isCreatingPo && creatingSupplier === supplierName;
                const createDisabled = isCreatingPo || !canWrite || selectedCount === 0 || !receivingLocation;
                const createTitle = !canWrite
                  ? "Writing to Cin7 is disabled on your current plan."
                  : selectedCount > 0 && !receivingLocation
                    ? "Choose a receiving location above — this report has no location of its own to fall back on."
                    : undefined;
                return (
                  <div key={supplierName} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-semibold text-slate-900">
                        {supplierName}{" "}
                        <span className="ml-2 text-sm font-normal text-slate-400">
                          {groupLines.length} line{groupLines.length === 1 ? "" : "s"}
                        </span>
                      </p>
                      <button
                        type="button"
                        onClick={() => handleCreatePo(supplierName, groupLines)}
                        disabled={createDisabled}
                        title={createTitle}
                        className="rounded-full bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
                      >
                        {isCreatingThisSupplier && <Spinner className="mr-1.5" />}
                        {isCreatingThisSupplier
                          ? "Creating…"
                          : `Create PO${selectedCount > 0 ? ` (${selectedCount} line${selectedCount === 1 ? "" : "s"})` : ""}`}
                      </button>
                    </div>

                    {poResult?.error && (
                      <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{poResult.error}</p>
                    )}
                    {poResult && (poResult.created.length > 0 || poResult.failed.length > 0) && (
                      <div className="mt-3 flex flex-col gap-2">
                        {poResult.created.length > 0 && (
                          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
                            Created {poResult.created.length} draft PO{poResult.created.length === 1 ? "" : "s"} in Cin7 — review and
                            authorize {poResult.created.length === 1 ? "it" : "them"} there:
                            <ul className="mt-1 list-disc pl-5">
                              {poResult.created.map((po) => (
                                <li key={`${po.orderNumber}-${po.locationName}`}>
                                  <strong>{po.orderNumber}</strong> → {po.locationName} ({po.lineCount} line{po.lineCount === 1 ? "" : "s"},{" "}
                                  {po.status})
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                        {poResult.failed.length > 0 && (
                          <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                            {poResult.failed.length} PO{poResult.failed.length === 1 ? "" : "s"} failed to create:
                            <ul className="mt-1 list-disc pl-5">
                              {poResult.failed.map((f) => (
                                <li key={`${f.supplierName}-${f.locationName}`}>
                                  {f.locationName}: {f.error}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="mt-3 overflow-x-auto">
                      <table className="w-full text-left text-sm">
                        <thead>
                          <tr className="border-b border-slate-200 text-slate-500">
                            <th className="py-2 pr-4">
                              <input
                                type="checkbox"
                                checked={allSelected}
                                ref={(el) => {
                                  if (el) el.indeterminate = selectedCount > 0 && selectedCount < groupLines.length;
                                }}
                                onChange={() => toggleSupplierLines(groupLines)}
                                className="h-4 w-4"
                              />
                            </th>
                            <th className="py-2 pr-4 font-medium">Product</th>
                            <th className="py-2 pr-4 text-right font-medium">On Hand</th>
                            <th className="py-2 pr-4 text-right font-medium">On Order</th>
                            <th className="py-2 pr-4 text-right font-medium">Reorder At</th>
                            <th className="py-2 pr-4 text-right font-medium">Suggested Qty</th>
                            <th className="py-2 pr-4 text-right font-medium">Latest Price</th>
                            <th className="py-2 pr-4 font-medium">Mover</th>
                            <th className="py-2 pr-4 font-medium">Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {groupLines.map((line) => {
                            const key = lineKey(line);
                            const checked = !excludedLineKeys.has(key);
                            return (
                              <tr
                                key={key}
                                className={`border-b border-slate-100 ${line.needsReorder ? "bg-amber-50/50" : ""} ${checked ? "" : "opacity-50"}`}
                              >
                                <td className="py-1.5 pr-4">
                                  <input type="checkbox" checked={checked} onChange={() => toggleLine(key)} className="h-4 w-4" />
                                </td>
                                <td className="py-2 pr-4">
                                  <div className="font-medium text-slate-900">{line.productName}</div>
                                  <div className="text-xs text-slate-400">{line.productSku}</div>
                                  {line.pendingPurchaseOrder && (
                                    <span
                                      className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-700"
                                      title={`Created ${new Date(line.pendingPurchaseOrder.createdAt).toLocaleString()} — not yet authorized in Cin7. Deselected by default to avoid a duplicate.`}
                                    >
                                      {line.pendingPurchaseOrder.orderNumber} pending authorization
                                    </span>
                                  )}
                                </td>
                                <td className="py-2 pr-4 text-right">{qty(line.onHand)}</td>
                                <td className="py-2 pr-4 text-right">{qty(line.onOrder)}</td>
                                <td className="py-2 pr-4 text-right">{qty(line.threshold)}</td>
                                <td className="py-2 pr-4 text-right font-medium">{qty(line.suggestedQty)}</td>
                                <td className="py-2 pr-4 text-right">{lineMoney(line.cost, line.currency)}</td>
                                <td className="py-2 pr-4">
                                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${MOVER_BADGE[line.moverCategory]}`}>
                                    {line.moverCategory}
                                  </span>
                                </td>
                                <td className="py-2 pr-4">
                                  <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS_BADGE[line.status]}`}>
                                    {line.status}
                                  </span>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </section>
      )}
    </>
  );
}
