"use client";

import { Fragment, useState, useTransition, useEffect } from "react";
import {
  loadReportFilterOptionsAction,
  loadProductSalesReportAction,
  loadSaleLineDetailsAction,
  loadSalesSyncStatusAction,
  triggerSalesSyncAction,
} from "./actions";
import type { ReportFilterOptions, ProductSalesReportRow, SaleLineDetailRow, SalesSyncStatus } from "@/reports/query";
import type { SalesReportFilters } from "@/reports/query";

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

export default function ReportsPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [syncStatus, setSyncStatus] = useState<SalesSyncStatus | null>(null);
  const [isSyncing, startSyncTransition] = useTransition();
  const [syncError, setSyncError] = useState<string | null>(null);

  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [categoryCode, setCategoryCode] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [rows, setRows] = useState<ProductSalesReportRow[] | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [expandedSku, setExpandedSku] = useState<string | null>(null);
  const [details, setDetails] = useState<Record<string, SaleLineDetailRow[]>>({});
  const [isLoadingDetails, startDetailsTransition] = useTransition();

  function refreshOptionsAndStatus() {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
    loadSalesSyncStatusAction().then((result) => {
      if (result.ok) setSyncStatus(result.data ?? null);
    });
  }

  useEffect(() => {
    refreshOptionsAndStatus();
  }, []);

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
    setExpandedSku(null);
    setDetails({});
    startRunTransition(async () => {
      const result = await loadProductSalesReportAction(currentFilters());
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setRows(result.data ?? []);
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

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Sales Report</h1>
      <p className="mt-2 text-lg text-slate-500">
        Revenue, COGS, profit and margin% per product sold, across every invoiced sale pulled from
        your connected Cin7 instances.
      </p>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
          <button
            type="button"
            onClick={handleSync}
            disabled={isSyncing}
            className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isSyncing ? "Syncing…" : "Sync sales now"}
          </button>
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

        <button
          type="button"
          onClick={handleRunReport}
          disabled={isRunning}
          className="mt-5 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {isRunning ? "Running…" : "Run report"}
        </button>

        {reportError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{reportError}</p>}
      </section>

      {rows && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="font-medium text-slate-900">
            {rows.length} product{rows.length === 1 ? "" : "s"}
          </p>
          {rows.length === 0 && <p className="mt-2 text-sm text-slate-400">No invoiced sales match these filters.</p>}

          {rows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4">Product</th>
                    <th className="py-2 pr-4">Qty sold</th>
                    <th className="py-2 pr-4">Revenue</th>
                    <th className="py-2 pr-4">COGS</th>
                    <th className="py-2 pr-4">Profit</th>
                    <th className="py-2 pr-4">Margin%</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
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
                        <tr key={`${row.product_sku}-detail`}>
                          <td colSpan={6} className="bg-slate-50 px-4 py-3">
                            {isLoadingDetails && !details[row.product_sku] && <p className="text-sm text-slate-400">Loading invoice lines…</p>}
                            {details[row.product_sku] && (
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
                                  {details[row.product_sku].map((line, i) => (
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
                                  {details[row.product_sku].length === 0 && (
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
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
