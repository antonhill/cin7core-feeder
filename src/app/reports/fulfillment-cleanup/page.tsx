"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { loadReportFilterOptionsAction } from "../actions";
import { loadFulfillmentCleanupPreviewAction, downloadFulfillmentCleanupCsvAction } from "./actions";
import type { ReportFilterOptions } from "@/reports/query";
import type { FulfillmentCleanupLine } from "@/reports/fulfillment-cleanup/build";
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

  const [lines, setLines] = useState<FulfillmentCleanupLine[] | null>(null);
  const [missingCostSkus, setMissingCostSkus] = useState<string[]>([]);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, startPreviewTransition] = useTransition();

  const [isDownloading, startDownloadTransition] = useTransition();
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);

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
    startPreviewTransition(async () => {
      const result = await loadFulfillmentCleanupPreviewAction(instanceId);
      if (!result.ok) {
        setPreviewError(result.error ?? "Unknown error");
        return;
      }
      setLines(result.data?.lines ?? []);
      setMissingCostSkus(result.data?.missingCostSkus ?? []);
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

  return (
    <>
      <ReportDescription title="Fulfillment Cleanup Helper">
        Generates a completed Cin7 Bulk Stock Adjustment CSV for every product currently oversold (negative
        availability) on one instance — the exact backlog blocking <Link href="/reports/order-fulfillment" className="underline">Order Fulfillment</Link>&rsquo;s
        Pick Today queue. Each line brings that SKU&rsquo;s availability back to zero; lines with no stock on hand at
        all are marked <strong>Zero</strong> with a cost filled in from the product&rsquo;s current average cost,
        lines that still have some stock on hand are marked <strong>NonZero</strong> and left for Cin7 to cost from
        its own existing average. This only builds the file — review it and import it into Cin7 yourself when
        you&rsquo;re ready; nothing here writes to Cin7.
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

      {lines && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <p className="font-medium text-slate-900">
              {lines.length} line{lines.length === 1 ? "" : "s"} — {lines.filter((l) => l.action === "Zero").length} Zero,{" "}
              {lines.filter((l) => l.action === "NonZero").length} NonZero
            </p>
            {lines.length > 0 && (
              <button
                type="button"
                onClick={handleDownload}
                disabled={isDownloading}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isDownloading ? "Preparing…" : "Download CSV"}
              </button>
            )}
          </div>
          {downloadError && <p className="mt-2 text-sm text-red-600">{downloadError}</p>}
          {downloadedFilename && (
            <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Downloaded {downloadedFilename} — review it, then import it into Cin7&rsquo;s Bulk Stock Adjustment screen yourself.
            </p>
          )}

          {missingCostSkus.length > 0 && (
            <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {missingCostSkus.length} SKU{missingCostSkus.length === 1 ? " has" : "s have"} no average cost on file, so its
              UnitCost is blank below — fill it in by hand before importing: {missingCostSkus.join(", ")}
            </p>
          )}

          {lines.length === 0 && <p className="mt-4 text-sm text-slate-400">Nothing is currently oversold on this instance.</p>}

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
