"use client";

import { Fragment, useMemo, useState, useTransition } from "react";
import { listAssembliesAction, getAssemblyDetailAction, exportAssembliesXlsxAction, exportAssembliesDetailXlsxAction } from "./actions";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import type { Cin7FinishedGoodsListEntry, Cin7FinishedGoodsDetail } from "@/cin7/finished-goods";
import type { AssemblyWithDetail } from "@/reports/assemblies-export";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "../ReportDescription";

type AssemblySortColumn = "assemblyNumber" | "product" | "status" | "date" | "quantity" | "totalCost";

function assemblySortValue(entry: Cin7FinishedGoodsListEntry, column: AssemblySortColumn): string | number | null {
  switch (column) {
    case "assemblyNumber":
      return entry.AssemblyNumber ?? null;
    case "product":
      return entry.ProductName ?? entry.ProductCode ?? null;
    case "status":
      return entry.Status ?? null;
    case "date":
      return entry.Date ?? null;
    case "quantity":
      return entry.Quantity ?? 0;
    case "totalCost":
      return totalCost(entry);
  }
}

/** Decodes the base64 .xlsx bytes the server rendered and triggers a normal browser download — same pattern as reports/page.tsx's downloadBase64File. */
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

/**
 * The 4 statuses Anton asked to filter by. VOIDED is deliberately left out —
 * confirmed live (see docs/cin7-api-findings.md / finished-goods.ts) as a
 * real 5th status Cin7 uses for cancelled assembly records, but this report
 * is about builds still relevant to the business, not a cancellation log —
 * a voided assembly never shows here regardless of filter selection.
 */
const STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft", badge: "bg-slate-100 text-slate-700" },
  { value: "AUTHORISED", label: "Authorised", badge: "bg-amber-100 text-amber-800" },
  { value: "IN PROGRESS", label: "In Progress", badge: "bg-indigo-100 text-indigo-800" },
  { value: "COMPLETED", label: "Completed", badge: "bg-emerald-100 text-emerald-800" },
] as const;

const ALL_STATUS_VALUES = STATUS_OPTIONS.map((s) => s.value);

/** Shows just the date portion of an ISO timestamp; blank input stays blank rather than showing "Invalid Date". */
function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "—";
}

/**
 * Quantity * UnitCost — both confirmed live on the list response itself (see
 * finished-goods.ts), no per-record detail call needed. No currency symbol:
 * Cin7 doesn't expose one on this resource, so this is shown as a plain
 * formatted number rather than assuming a currency.
 */
function totalCost(entry: Cin7FinishedGoodsListEntry): number {
  return (entry.Quantity ?? 0) * (entry.UnitCost ?? 0);
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function matchesSearch(search: string, entry: Cin7FinishedGoodsListEntry): boolean {
  if (!search.trim()) return true;
  const needle = search.trim().toLowerCase();
  return (
    (entry.AssemblyNumber ?? "").toLowerCase().includes(needle) ||
    (entry.ProductName ?? "").toLowerCase().includes(needle) ||
    (entry.ProductCode ?? "").toLowerCase().includes(needle)
  );
}

/** Estimated (planned BOM) total — sum of OrderLines' TotalCost. */
function estimatedTotal(detail: Cin7FinishedGoodsDetail): number {
  return (detail.OrderLines ?? []).reduce((sum, line) => sum + (line.TotalCost ?? 0), 0);
}

/** Actual (as-built) total — sum of each picked batch's Quantity * Cost. Can genuinely differ from the estimated total if wastage or substitution happened during the real build. */
function actualTotal(detail: Cin7FinishedGoodsDetail): number {
  return (detail.PickLines ?? []).reduce((sum, line) => sum + (line.Quantity ?? 0) * (line.Cost ?? 0), 0);
}

function AssemblyDetailPanel({
  detail,
  isLoading,
  error,
}: {
  detail: Cin7FinishedGoodsDetail | undefined;
  isLoading: boolean;
  error: string | undefined;
}) {
  if (isLoading)
    return (
      <p className="px-4 py-3 text-sm text-slate-500">
        <Spinner className="mr-1.5" />
        Loading components…
      </p>
    );
  if (error) return <p className="px-4 py-3 text-sm text-red-700">{error}</p>;
  if (!detail) return null;

  const orderLines = detail.OrderLines ?? [];
  const pickLines = detail.PickLines ?? [];

  return (
    <div className="flex flex-col gap-4 px-4 py-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Components (planned)</p>
        {orderLines.length > 0 ? (
          <table className="mt-2 w-full text-left text-sm text-slate-700">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400">
                <th className="py-1 pr-4 font-medium">Product</th>
                <th className="py-1 pr-4 text-right font-medium">Quantity</th>
                <th className="py-1 pr-4 text-right font-medium">Wastage</th>
                <th className="py-1 pr-4 text-right font-medium">Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {orderLines.map((line, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 pr-4">
                    {line.Name || "—"} <span className="text-xs text-slate-400">({line.ProductCode || "—"})</span>
                  </td>
                  <td className="py-1 pr-4 text-right">
                    {formatNumber(line.TotalQuantity ?? line.Quantity ?? 0)} {line.Unit ?? ""}
                  </td>
                  <td className="py-1 pr-4 text-right">{line.WastagePercent ? `${formatNumber(line.WastagePercent)}%` : "—"}</td>
                  <td className="py-1 pr-4 text-right">{formatNumber(line.TotalCost ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-1 text-sm text-slate-500">No planned components recorded for this build.</p>
        )}
      </div>

      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Actual consumption</p>
        {pickLines.length > 0 ? (
          <table className="mt-2 w-full text-left text-sm text-slate-700">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400">
                <th className="py-1 pr-4 font-medium">Product</th>
                <th className="py-1 pr-4 font-medium">Batch/SN</th>
                <th className="py-1 pr-4 text-right font-medium">Quantity</th>
                <th className="py-1 pr-4 text-right font-medium">Cost</th>
                <th className="py-1 pr-4 text-right font-medium">Line Cost</th>
              </tr>
            </thead>
            <tbody>
              {pickLines.map((line, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="py-1 pr-4">
                    {line.Name || "—"} <span className="text-xs text-slate-400">({line.ProductCode || "—"})</span>
                  </td>
                  <td className="py-1 pr-4">{line.BatchSN || "—"}</td>
                  <td className="py-1 pr-4 text-right">
                    {formatNumber(line.Quantity ?? 0)} {line.Unit ?? ""}
                  </td>
                  <td className="py-1 pr-4 text-right">{formatNumber(line.Cost ?? 0)}</td>
                  <td className="py-1 pr-4 text-right">{formatNumber((line.Quantity ?? 0) * (line.Cost ?? 0))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-1 text-sm text-slate-500">Nothing picked/consumed yet for this build.</p>
        )}
      </div>

      <p className="text-sm font-medium text-slate-700">
        Estimated total: {formatNumber(estimatedTotal(detail))} · Actual total: {formatNumber(actualTotal(detail))}
      </p>

      {/* Resources/additional costs (labor, overhead) aren't shown here — not yet confirmed live
          whether a built assembly's detail response carries a services/resources array at all
          (see Cin7FinishedGoodsDetail's own comment in finished-goods.ts). Surfacing this
          honestly rather than silently omitting it. */}
      <p className="text-xs text-slate-400">
        Resources/additional costs (labor, overhead) aren&rsquo;t available yet — pending confirmation of the
        field name against a live account with services configured on its Assembly BOM.
      </p>
    </div>
  );
}

export default function AssembliesPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [assemblies, setAssemblies] = useState<Cin7FinishedGoodsListEntry[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isScanning, startScanTransition] = useTransition();

  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(ALL_STATUS_VALUES));
  const [search, setSearch] = useState("");

  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [detailsById, setDetailsById] = useState<Record<string, Cin7FinishedGoodsDetail>>({});
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});
  const [loadingDetailIds, setLoadingDetailIds] = useState<Set<string>>(new Set());

  const [exportError, setExportError] = useState<string | null>(null);
  const [isExporting, startExportTransition] = useTransition();

  // Deliberately its own state, not shared with isExporting above — a shared
  // flag would light up both export buttons on either one's click (the same
  // bug already fixed elsewhere this session, see PageLoadingIndicator).
  const [isExportingDetail, setIsExportingDetail] = useState(false);
  const [detailExportError, setDetailExportError] = useState<string | null>(null);
  const [detailExportProgress, setDetailExportProgress] = useState<{ done: number; total: number } | null>(null);

  function toggleStatus(value: string) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  function handleScan() {
    if (!instanceId) return;
    setScanError(null);
    setAssemblies(null);
    setExpandedIds(new Set());
    setDetailsById({});
    setDetailErrors({});
    startScanTransition(async () => {
      const res = await listAssembliesAction(instanceId);
      if (!res.ok) {
        setScanError(res.error ?? "Unknown error");
        return;
      }
      setAssemblies(res.data ?? []);
    });
  }

  function handleToggleExpand(taskId: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });

    // Fetch on first expand only — already-cached or in-flight requests aren't repeated.
    if (!instanceId || detailsById[taskId] || loadingDetailIds.has(taskId)) return;
    setLoadingDetailIds((prev) => new Set(prev).add(taskId));
    setDetailErrors((prev) => {
      if (!(taskId in prev)) return prev;
      const rest = { ...prev };
      delete rest[taskId];
      return rest;
    });
    getAssemblyDetailAction(instanceId, taskId).then((res) => {
      setLoadingDetailIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      if (!res.ok || !res.data) {
        setDetailErrors((prev) => ({ ...prev, [taskId]: res.error ?? "Unknown error" }));
        return;
      }
      setDetailsById((prev) => ({ ...prev, [taskId]: res.data! }));
    });
  }

  const [sortColumn, setSortColumn] = useState<AssemblySortColumn>("date");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  function handleSort(column: AssemblySortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const filtered = useMemo(
    () => (assemblies ?? []).filter((a) => statusFilter.has((a.Status ?? "").trim().toUpperCase())).filter((a) => matchesSearch(search, a)),
    [assemblies, statusFilter, search]
  );

  // Newest-first (date desc) is the default, matching this report's previous fixed order — sortColumn/sortDirection let the user override it.
  const sortedFiltered = useMemo(() => {
    const copy = [...filtered];
    copy.sort((a, b) => {
      const cmp = compareNullable(assemblySortValue(a, sortColumn), assemblySortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filtered, sortColumn, sortDirection]);

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, a) => ({ quantity: acc.quantity + (a.Quantity ?? 0), cost: acc.cost + totalCost(a) }),
        { quantity: 0, cost: 0 }
      ),
    [filtered]
  );

  function handleExport() {
    if (filtered.length === 0) return;
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportAssembliesXlsxAction(sortedFiltered);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "assemblies.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  /**
   * Fetches each currently-filtered assembly's detail one request at a time
   * (reusing already-cached ones from expanded rows) rather than looping
   * inside a single server action — the Cin7 client self-throttles to 60
   * calls/min, so a large filtered set could take well over a minute, which
   * would risk hitting Vercel's function timeout if done as one server-side
   * loop. Sequencing it from here keeps every individual request quick.
   */
  async function handleExportDetail() {
    if (!instanceId || filtered.length === 0) return;
    setDetailExportError(null);
    setIsExportingDetail(true);
    setDetailExportProgress({ done: 0, total: filtered.length });

    const rows: AssemblyWithDetail[] = [];
    const newDetails: Record<string, Cin7FinishedGoodsDetail> = {};
    const newErrors: Record<string, string> = {};

    for (let i = 0; i < sortedFiltered.length; i++) {
      const entry = sortedFiltered[i];
      let detail = detailsById[entry.TaskID];
      let detailError = detailErrors[entry.TaskID];
      if (!detail) {
        const res = await getAssemblyDetailAction(instanceId, entry.TaskID);
        if (res.ok && res.data) {
          detail = res.data;
          newDetails[entry.TaskID] = res.data;
        } else {
          detailError = res.error ?? "Unknown error";
          newErrors[entry.TaskID] = detailError;
        }
      }
      rows.push({ entry, detail, detailError });
      setDetailExportProgress({ done: i + 1, total: filtered.length });
    }

    // Share newly-fetched details/errors with the on-screen expand cache too, so expanding a row this export just fetched doesn't re-fetch it.
    if (Object.keys(newDetails).length > 0) setDetailsById((prev) => ({ ...prev, ...newDetails }));
    if (Object.keys(newErrors).length > 0) setDetailErrors((prev) => ({ ...prev, ...newErrors }));

    const result = await exportAssembliesDetailXlsxAction(rows);
    setIsExportingDetail(false);
    setDetailExportProgress(null);
    if (!result.ok || !result.data) {
      setDetailExportError(result.error ?? "Unknown error");
      return;
    }
    downloadBase64File(result.data, "assemblies-detail.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  return (
    <>
      <ReportDescription title="Current Assembly Costs">
        Every Assembly Build on this instance, with its quantity and total BOM cost, filterable by status. Cin7 Core
        shows this one build at a time — this lists every assembly at once so you can spot incomplete or failed
        builds, audit costs across the whole catalog, and export the full picture (or just planned-vs-actual detail)
        to Excel in one pass.
      </ReportDescription>
      <PageLoadingIndicator
        show={isExportingDetail}
        label={detailExportProgress ? `Fetching component details… (${detailExportProgress.done} of ${detailExportProgress.total})` : "Preparing detail export…"}
      />
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Instance</p>
        <div className="mt-3">
          <InstancePicker {...picker} onChange={picker.setInstanceId} />
        </div>

        <button
          type="button"
          onClick={handleScan}
          disabled={isScanning || !instanceId}
          className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {isScanning && <Spinner className="mr-1.5" />}
          {isScanning ? "Scanning…" : "Scan assemblies"}
        </button>
        {scanError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{scanError}</p>}
      </section>

      {assemblies && (
        <section className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700">Status</p>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  {STATUS_OPTIONS.map((s) => (
                    <label key={s.value} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={statusFilter.has(s.value)} onChange={() => toggleStatus(s.value)} className="h-4 w-4" />
                      {s.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex-1 sm:max-w-xs">
                <p className="text-sm font-medium text-slate-700">Search</p>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Assembly number or product…"
                  className="mt-2 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
            <p>
              {filtered.length} of {assemblies.length} assembl{assemblies.length === 1 ? "y" : "ies"} shown
            </p>
            <div className="flex items-center gap-3">
              <p className="font-medium text-slate-700">
                Total quantity: {formatNumber(totals.quantity)} · Total cost: {formatNumber(totals.cost)}
              </p>
              <button
                type="button"
                onClick={handleExport}
                disabled={isExporting || filtered.length === 0}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isExporting && <Spinner className="mr-1.5" />}
                {isExporting ? "Exporting…" : "Export .xlsx"}
              </button>
              <button
                type="button"
                onClick={handleExportDetail}
                disabled={isExportingDetail || filtered.length === 0}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                title="Includes every component line and the estimated (planned) vs actual (as-built) total per assembly."
              >
                Export detail (planned vs actual) .xlsx
              </button>
            </div>
          </div>
          {exportError && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{exportError}</p>}
          {detailExportError && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{detailExportError}</p>}

          {filtered.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-sm text-slate-700">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="w-8 px-2 py-2"></th>
                    <SortHeader
                      label="Assembly #"
                      column="assemblyNumber"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader label="Product" column="product" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Status" column="status" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader label="Date" column="date" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                    <SortHeader
                      label="Quantity"
                      column="quantity"
                      align="right"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                    <SortHeader
                      label="Total Cost"
                      column="totalCost"
                      align="right"
                      thClassName="px-4 py-2"
                      sortColumn={sortColumn}
                      sortDirection={sortDirection}
                      onSort={handleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {sortedFiltered.map((a) => {
                    const statusOption = STATUS_OPTIONS.find((s) => s.value === (a.Status ?? "").trim().toUpperCase());
                    const isExpanded = expandedIds.has(a.TaskID);
                    return (
                      <Fragment key={a.TaskID}>
                        <tr
                          onClick={() => handleToggleExpand(a.TaskID)}
                          className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                        >
                          <td className="px-2 py-2 align-top text-center text-slate-400">{isExpanded ? "▾" : "▸"}</td>
                          <td className="px-4 py-2 align-top">{a.AssemblyNumber || "—"}</td>
                          <td className="px-4 py-2 align-top">
                            {a.ProductName || "—"} <span className="text-xs text-slate-400">({a.ProductCode || "—"})</span>
                          </td>
                          <td className="px-4 py-2 align-top">
                            <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusOption?.badge ?? "bg-slate-100 text-slate-700"}`}>
                              {statusOption?.label ?? a.Status ?? "—"}
                            </span>
                          </td>
                          <td className="px-4 py-2 align-top">{dateOnly(a.Date)}</td>
                          <td className="px-4 py-2 align-top text-right">{formatNumber(a.Quantity ?? 0)}</td>
                          <td className="px-4 py-2 align-top text-right">{formatNumber(totalCost(a))}</td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b border-slate-100 bg-slate-50 last:border-0">
                            <td colSpan={7}>
                              <AssemblyDetailPanel
                                detail={detailsById[a.TaskID]}
                                isLoading={loadingDetailIds.has(a.TaskID)}
                                error={detailErrors[a.TaskID]}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-base text-slate-500">No assemblies match the current filter.</p>
          )}
        </section>
      )}
    </>
  );
}
