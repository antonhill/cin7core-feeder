"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { loadReportFilterOptionsAction } from "../actions";
import {
  loadFulfillmentCleanupPreviewAction,
  downloadFulfillmentCleanupCsvAction,
  downloadIncludedSalesCsvAction,
  type FulfillmentCleanupPreviewData,
} from "./actions";
import type { ReportFilterOptions } from "@/reports/query";
import { buildFulfillmentCleanupLines } from "@/reports/fulfillment-cleanup/build";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "../ReportDescription";

function triggerCsvDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function qty(value: number): string {
  return value.toLocaleString();
}

export default function FulfillmentCleanupPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [isLoadingOptions, startOptionsTransition] = useTransition();
  const [instanceId, setInstanceId] = useState("");

  const [previewData, setPreviewData] = useState<FulfillmentCleanupPreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, startPreviewTransition] = useTransition();

  const [excludedSaleIds, setExcludedSaleIds] = useState<Set<string>>(new Set());

  const [isDownloading, startDownloadTransition] = useTransition();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);

  const [isDownloadingIncludedSales, startIncludedSalesTransition] = useTransition();
  const [includedSalesError, setIncludedSalesError] = useState<string | null>(null);
  const [includedSalesFilename, setIncludedSalesFilename] = useState<string | null>(null);

  // Recomputed instantly whenever a sale is excluded/included — no server
  // round trip, since buildFulfillmentCleanupLines is a pure function and
  // the action already handed over every raw ingredient it needs.
  const lines = useMemo(() => {
    if (!previewData) return null;
    return buildFulfillmentCleanupLines(
      previewData.negativeAvailabilityRows,
      new Map(previewData.averageCostEntries.map((e) => [e.sku, e.averageCost])),
      previewData.todayIso,
      previewData.backorderDemand,
      excludedSaleIds
    );
  }, [previewData, excludedSaleIds]);

  const missingCostSkus = useMemo(() => {
    if (!lines) return [];
    return [...new Set(lines.filter((l) => l.action === "Zero" && l.unitCost === null).map((l) => l.productSku))];
  }, [lines]);

  // Every backordered sale the user did NOT exclude — the audit-trail export answers "which orders was this cleanup run meant to unblock?"
  const includedSales = useMemo(() => {
    if (!previewData) return [];
    return previewData.backorderedSales.filter((s) => !excludedSaleIds.has(s.cin7SaleId));
  }, [previewData, excludedSaleIds]);

  function handleLoadInstances() {
    setOptionsError(null);
    startOptionsTransition(async () => {
      const result = await loadReportFilterOptionsAction();
      if (!result.ok) {
        setOptionsError(result.error ?? "Unknown error");
        return;
      }
      setOptions(result.data ?? null);
      if (result.data?.instances.length === 1) setInstanceId(result.data.instances[0].id);
    });
  }

  function handlePreview() {
    if (!instanceId) return;
    setPreviewError(null);
    setDownloadedFilename(null);
    setIncludedSalesFilename(null);
    setExcludedSaleIds(new Set());
    startPreviewTransition(async () => {
      const result = await loadFulfillmentCleanupPreviewAction(instanceId);
      if (!result.ok) {
        setPreviewError(result.error ?? "Unknown error");
        return;
      }
      setPreviewData(result.data ?? null);
    });
  }

  function toggleExcluded(saleId: string) {
    setExcludedSaleIds((prev) => {
      const next = new Set(prev);
      if (next.has(saleId)) next.delete(saleId);
      else next.add(saleId);
      return next;
    });
  }

  function handleDownload() {
    if (!lines) return;
    setDownloadError(null);
    startDownloadTransition(async () => {
      const result = await downloadFulfillmentCleanupCsvAction(lines);
      if (!result.ok || !result.data) {
        setDownloadError(result.error ?? "Unknown error");
        return;
      }
      triggerCsvDownload(result.data, "BulkUpdateStockAdjustment.csv");
      setDownloadedFilename("BulkUpdateStockAdjustment.csv");
    });
  }

  function handleDownloadIncludedSales() {
    setIncludedSalesError(null);
    startIncludedSalesTransition(async () => {
      const result = await downloadIncludedSalesCsvAction(includedSales);
      if (!result.ok || !result.data) {
        setIncludedSalesError(result.error ?? "Unknown error");
        return;
      }
      triggerCsvDownload(result.data, "FulfillmentCleanup_IncludedSales.csv");
      setIncludedSalesFilename("FulfillmentCleanup_IncludedSales.csv");
    });
  }

  return (
    <>
      <ReportDescription title="Fulfillment Cleanup Helper">
        Generates a completed Cin7 Bulk Stock Adjustment CSV for every product currently oversold (negative
        availability) on one instance — the exact backlog blocking <Link href="/reports/order-fulfillment" className="underline">Order Fulfillment</Link>&rsquo;s
        Pick Today queue. Each line brings that SKU&rsquo;s availability back to zero; lines with no stock on hand at
        all are marked <strong>Zero</strong> with a cost filled in from the product&rsquo;s current average cost,
        lines that still have some stock on hand are marked <strong>NonZero</strong> and left for Cin7 to cost from
        its own existing average. Some backordered sales should legitimately stay unfulfilled — exclude them below
        and their share of each SKU&rsquo;s correction is removed. This only builds the file — review it and import
        it into Cin7 yourself when you&rsquo;re ready; nothing here writes to Cin7.
      </ReportDescription>
      <PageLoadingIndicator show={isDownloading} label="Preparing CSV…" />

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={handleLoadInstances}
                disabled={isLoadingOptions}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isLoadingOptions && <Spinner className="mr-1.5" />}
                {isLoadingOptions ? "Loading…" : "Load instances"}
              </button>
              {options && options.instances.length > 0 && (
                <select
                  value={instanceId}
                  onChange={(e) => setInstanceId(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">Choose an instance…</option>
                  {options.instances.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {options && options.instances.length === 0 && <p className="mt-2 text-sm text-slate-400">No instances connected.</p>}
            <p className="mt-2 text-xs text-slate-400">
              Reads from Stock Health&rsquo;s already-synced stock levels — if it&rsquo;s been a while,{" "}
              <Link href="/reports/stock-health" className="underline">
                sync stock levels
              </Link>{" "}
              first so this reflects the current backlog.
            </p>
          </div>
          <button
            type="button"
            onClick={handlePreview}
            disabled={isLoadingPreview || !instanceId}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isLoadingPreview && <Spinner className="mr-1.5" />}
            {isLoadingPreview ? "Building…" : "Build cleanup list"}
          </button>
        </div>
        {optionsError && <p className="mt-2 text-sm text-red-600">{optionsError}</p>}
        {previewError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{previewError}</p>}
      </section>

      {previewData && previewData.backorderedSales.length > 0 && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="font-medium text-slate-900">Exclude sales that should legitimately stay unfulfilled</p>
          <p className="mt-1 text-sm text-slate-500">
            Ticking a sale removes its share of each SKU&rsquo;s correction below — the rest of that SKU&rsquo;s
            backlog (from sales you haven&rsquo;t excluded) is still cleaned up.
          </p>
          <div className="mt-4 flex flex-col gap-1">
            {previewData.backorderedSales.map((sale) => (
              <label key={sale.cin7SaleId} className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={excludedSaleIds.has(sale.cin7SaleId)}
                  onChange={() => toggleExcluded(sale.cin7SaleId)}
                  className="h-4 w-4"
                />
                <span className="font-medium text-slate-900">{sale.orderNumber ?? sale.cin7SaleId}</span>
                <span className="text-slate-400">{sale.customerName}</span>
                {sale.customerReference && <span className="text-xs text-slate-400">Ref: {sale.customerReference}</span>}
                <span className="text-xs text-slate-400">{sale.orderDate ?? "—"}</span>
                <span className="ml-auto text-xs text-slate-400">{qty(sale.totalBackorderQty)} backordered</span>
              </label>
            ))}
          </div>
        </section>
      )}

      {lines && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <p className="font-medium text-slate-900">
              {lines.length} line{lines.length === 1 ? "" : "s"} — {lines.filter((l) => l.action === "Zero").length} Zero,{" "}
              {lines.filter((l) => l.action === "NonZero").length} NonZero
              {excludedSaleIds.size > 0 && ` (${excludedSaleIds.size} sale${excludedSaleIds.size === 1 ? "" : "s"} excluded)`}
            </p>
            {lines.length > 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={handleDownloadIncludedSales}
                  disabled={isDownloadingIncludedSales || includedSales.length === 0}
                  className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {isDownloadingIncludedSales ? "Preparing…" : "Export included sales"}
                </button>
                <button
                  type="button"
                  onClick={handleDownload}
                  disabled={isDownloading}
                  className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {isDownloading ? "Preparing…" : "Download CSV"}
                </button>
              </div>
            )}
          </div>
          {downloadError && <p className="mt-2 text-sm text-red-600">{downloadError}</p>}
          {downloadedFilename && (
            <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Downloaded {downloadedFilename} — review it, then import it into Cin7&rsquo;s Bulk Stock Adjustment screen yourself.
            </p>
          )}
          {includedSalesError && <p className="mt-2 text-sm text-red-600">{includedSalesError}</p>}
          {includedSalesFilename && (
            <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Downloaded {includedSalesFilename} — {includedSales.length} sale{includedSales.length === 1 ? "" : "s"} this cleanup run assumed would become fulfillable.
            </p>
          )}

          {missingCostSkus.length > 0 && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {missingCostSkus.length} SKU{missingCostSkus.length === 1 ? " has" : "s have"} no average cost on file, so its
              UnitCost is blank below — fill it in by hand before importing: {missingCostSkus.join(", ")}
            </p>
          )}

          {lines.length === 0 && (
            <p className="mt-4 text-sm text-slate-400">
              {excludedSaleIds.size > 0
                ? "Nothing left to correct — every remaining shortfall was covered by excluded sales."
                : "Nothing is currently oversold on this instance."}
            </p>
          )}

          {lines.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4">Action</th>
                    <th className="py-2 pr-4">Product</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4">Bin</th>
                    <th className="py-2 pr-4">Batch/SN</th>
                    <th className="py-2 pr-4 text-right">Quantity</th>
                    <th className="py-2 pr-4 text-right">Unit Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-4">
                        <span
                          className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                            line.action === "Zero" ? "bg-amber-100 text-amber-700" : "bg-slate-100 text-slate-600"
                          }`}
                        >
                          {line.action}
                        </span>
                      </td>
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-900">{line.productName ?? line.productSku}</div>
                        <div className="text-xs text-slate-400">{line.productSku}</div>
                      </td>
                      <td className="py-2 pr-4">{line.location ?? <span className="text-slate-300">—</span>}</td>
                      <td className="py-2 pr-4">{line.bin ?? <span className="text-slate-300">—</span>}</td>
                      <td className="py-2 pr-4">{line.batchSn ?? <span className="text-slate-300">—</span>}</td>
                      <td className="py-2 pr-4 text-right font-medium">{qty(line.quantity)}</td>
                      <td className="py-2 pr-4 text-right">
                        {line.unitCost === null ? <span className="text-slate-300">—</span> : line.unitCost.toFixed(2)}
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
