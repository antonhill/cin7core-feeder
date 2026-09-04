"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import {
  loadFulfillmentCleanupPreviewAction,
  downloadFulfillmentCleanupCsvAction,
  downloadIncludedSalesCsvAction,
  loadFulfillmentCleanupStockSyncStatusAction,
  triggerFulfillmentCleanupStockSyncAction,
  loadFulfillmentCleanupSalesSyncStatusAction,
  triggerFulfillmentCleanupSalesSyncAction,
  type FulfillmentCleanupPreviewData,
} from "./actions";
import type { ProductAvailabilitySyncStatus, SalesSyncStatus } from "@/reports/query";
import { buildFulfillmentCleanupLines } from "@/reports/fulfillment-cleanup/build";
import { SNAPSHOT_STALE_HOURS, hoursSince, StaleBadge, staleSyncButtonClass } from "../sync-staleness";
import { compareNullable, SortHeader } from "../sortable-table";
import { matchesSearch } from "../text-search";
import { SearchInput } from "../search-input";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "../ReportDescription";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";

type BackorderedSaleSortColumn = "orderNumber" | "customerName" | "customerReference" | "orderDate" | "totalBackorderQty";

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
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [stockSyncStatus, setStockSyncStatus] = useState<ProductAvailabilitySyncStatus | null>(null);
  const [stockSyncStatusError, setStockSyncStatusError] = useState<string | null>(null);
  const [isStockSyncing, startStockSyncTransition] = useTransition();
  const [stockSyncError, setStockSyncError] = useState<string | null>(null);

  // Sales detail-sync progress — separate from stock levels above, since
  // customer_reference and each sale's backorder line only populate once
  // sync-sales.ts's rate-limited detail phase reaches that specific order.
  // Without this, a user excluding/verifying a specific test order has no
  // way to tell "still queued" from "actually has nothing backordered".
  const [salesSyncStatus, setSalesSyncStatus] = useState<SalesSyncStatus | null>(null);
  const [salesSyncStatusError, setSalesSyncStatusError] = useState<string | null>(null);
  const [isSalesSyncing, startSalesSyncTransition] = useTransition();
  const [salesSyncError, setSalesSyncError] = useState<string | null>(null);

  // Stale once never synced, or synced too long ago — either means the
  // negative-availability list (and its Zero/NonZero cost basis) could be
  // wrong. Sales detail is "stale" whenever anything is still queued —
  // there's no safe time threshold for it, since even one un-synced order
  // could be the one a user is trying to exclude/verify right now.
  const isStockStale = Boolean(stockSyncStatus) && (!stockSyncStatus?.lastSyncedAt || hoursSince(stockSyncStatus.lastSyncedAt) > SNAPSHOT_STALE_HOURS);
  const isSalesStale = Boolean(salesSyncStatus) && (salesSyncStatus?.pendingDetail ?? 0) > 0;

  const [previewData, setPreviewData] = useState<FulfillmentCleanupPreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, startPreviewTransition] = useTransition();

  const [excludedSaleIds, setExcludedSaleIds] = useState<Set<string>>(new Set());
  const [sortColumn, setSortColumn] = useState<BackorderedSaleSortColumn>("orderNumber");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");

  function handleSort(column: BackorderedSaleSortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

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

  // P5.4 (LBL brief): filters only what's shown in the table below — the
  // downloaded CSV (handleDownload) always uses the full `lines` list,
  // since it's a correction file for Cin7 import, not a report export;
  // narrowing the on-screen view shouldn't silently drop lines from it.
  const [search, setSearch] = useState("");
  const visibleLines = useMemo(() => (lines ?? []).filter((l) => matchesSearch(search, l.productSku, l.productName)), [lines, search]);

  // Every backordered sale the user did NOT exclude — the audit-trail export answers "which orders was this cleanup run meant to unblock?"
  const includedSales = useMemo(() => {
    if (!previewData) return [];
    return previewData.backorderedSales.filter((s) => !excludedSaleIds.has(s.cin7SaleId));
  }, [previewData, excludedSaleIds]);

  const sortedBackorderedSales = useMemo(() => {
    if (!previewData) return [];
    const rows = [...previewData.backorderedSales];
    rows.sort((a, b) => {
      const cmp = compareNullable(a[sortColumn], b[sortColumn]);
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [previewData, sortColumn, sortDirection]);

  function refreshStockSyncStatus(forInstanceId: string) {
    setStockSyncStatusError(null);
    loadFulfillmentCleanupStockSyncStatusAction(forInstanceId).then((result) => {
      if (!result.ok) {
        setStockSyncStatusError(result.error ?? "Unknown error");
        return;
      }
      setStockSyncStatus(result.data ?? null);
    });
  }

  function refreshSalesSyncStatus(forInstanceId: string) {
    setSalesSyncStatusError(null);
    loadFulfillmentCleanupSalesSyncStatusAction(forInstanceId).then((result) => {
      if (!result.ok) {
        setSalesSyncStatusError(result.error ?? "Unknown error");
        return;
      }
      setSalesSyncStatus(result.data ?? null);
    });
  }

  // Refetch whenever the chosen instance changes — both sync statuses are
  // per instance, so an instance switch means the previous instance's
  // status no longer applies. No setState runs synchronously in the effect
  // body (only inside each .then() callback) — when instanceId is cleared
  // this just skips the fetch rather than clearing state directly; the JSX
  // below only ever renders these statuses while instanceId is set, so a
  // stale value from a previous instance never shows regardless.
  // refreshStockSyncStatus/refreshSalesSyncStatus (used by the sync button
  // handlers) do the same fetch from a real click handler, where a
  // synchronous setState is fine.
  useEffect(() => {
    if (!instanceId) return;
    loadFulfillmentCleanupStockSyncStatusAction(instanceId).then((result) => {
      if (!result.ok) {
        setStockSyncStatusError(result.error ?? "Unknown error");
        return;
      }
      setStockSyncStatus(result.data ?? null);
    });
    loadFulfillmentCleanupSalesSyncStatusAction(instanceId).then((result) => {
      if (!result.ok) {
        setSalesSyncStatusError(result.error ?? "Unknown error");
        return;
      }
      setSalesSyncStatus(result.data ?? null);
    });
  }, [instanceId]);

  function handleStockSync() {
    if (!instanceId) return;
    setStockSyncError(null);
    startStockSyncTransition(async () => {
      const result = await triggerFulfillmentCleanupStockSyncAction(instanceId);
      if (!result.ok) {
        setStockSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshStockSyncStatus(instanceId);
    });
  }

  function handleSalesSync() {
    if (!instanceId) return;
    setSalesSyncError(null);
    startSalesSyncTransition(async () => {
      const result = await triggerFulfillmentCleanupSalesSyncAction(instanceId);
      if (!result.ok) {
        setSalesSyncError(result.error ?? "Unknown error");
        return;
      }
      refreshSalesSyncStatus(instanceId);
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
        all are marked <strong>Zero</strong>{" "}
        with a cost filled in from the product&rsquo;s current average cost, lines that still have some stock on
        hand are marked <strong>NonZero</strong>{" "}
        and left for Cin7 to cost from its own existing average. Some backordered sales should legitimately stay
        unfulfilled — exclude them below
        and their share of each SKU&rsquo;s correction is removed. This only builds the file — review it and import
        it into Cin7 yourself when you&rsquo;re ready; nothing here writes to Cin7.
      </ReportDescription>
      <PageLoadingIndicator show={isDownloading} label="Preparing CSV…" />

      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
            {instanceId && (
              <div className="mt-2 flex flex-col gap-1.5">
                <div className="flex items-center gap-3">
                  <p className="w-72 text-xs text-slate-500">
                    Stock levels
                    {stockSyncStatus?.lastSyncedAt
                      ? ` — last synced ${new Date(stockSyncStatus.lastSyncedAt).toLocaleString()}`
                      : stockSyncStatus
                        ? " — never synced yet"
                        : ""}
                    .
                  </p>
                  {isStockStale && <StaleBadge label="Stale — sync recommended" />}
                  <button type="button" onClick={handleStockSync} disabled={isStockSyncing} className={staleSyncButtonClass(isStockStale)}>
                    {isStockSyncing && <Spinner className="mr-1.5" />}
                    {isStockSyncing ? "Syncing…" : "Sync stock levels now"}
                  </button>
                </div>
                <div className="flex items-center gap-3">
                  <p className="w-72 text-xs text-slate-500">
                    Sales detail
                    {salesSyncStatus
                      ? salesSyncStatus.pendingDetail > 0
                        ? ` — ${salesSyncStatus.pendingDetail.toLocaleString()} of ${salesSyncStatus.totalSales.toLocaleString()} sales still queued (customer reference/backorder data not final yet)`
                        : ` — all ${salesSyncStatus.totalSales.toLocaleString()} sales fully synced`
                      : ""}
                    .
                  </p>
                  {isSalesStale && <StaleBadge label="Behind — sync recommended" />}
                  <button type="button" onClick={handleSalesSync} disabled={isSalesSyncing} className={staleSyncButtonClass(isSalesStale)}>
                    {isSalesSyncing && <Spinner className="mr-1.5" />}
                    {isSalesSyncing ? "Syncing…" : "Sync sales now"}
                  </button>
                </div>
              </div>
            )}
            {stockSyncStatusError && (
              <div className="mt-2">
                <Alert tone="danger">{stockSyncStatusError}</Alert>
              </div>
            )}
            {stockSyncError && (
              <div className="mt-2">
                <Alert tone="danger">{stockSyncError}</Alert>
              </div>
            )}
            {salesSyncStatusError && (
              <div className="mt-2">
                <Alert tone="danger">{salesSyncStatusError}</Alert>
              </div>
            )}
            {salesSyncError && (
              <div className="mt-2">
                <Alert tone="danger">{salesSyncError}</Alert>
              </div>
            )}
          </div>
          <Button onClick={handlePreview} disabled={!instanceId} loading={isLoadingPreview}>
            {isLoadingPreview ? "Building…" : "Build cleanup list"}
          </Button>
        </div>
        {previewError && (
          <div className="mt-3">
            <Alert tone="danger">{previewError}</Alert>
          </div>
        )}
      </Panel>

      {previewData && previewData.backorderedSales.length > 0 && (
        <Panel className="mt-6">
          <p className="font-medium text-slate-900">Exclude sales that should legitimately stay unfulfilled</p>
          <p className="mt-1 text-sm text-slate-500">
            Ticking a sale removes its share of each SKU&rsquo;s correction below — the rest of that SKU&rsquo;s
            backlog (from sales you haven&rsquo;t excluded) is still cleaned up.
          </p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="border-b-2 border-slate-300 bg-slate-50">
                <tr>
                  <th className="py-2 pr-4"></th>
                  <SortHeader label="Order #" column="orderNumber" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  <SortHeader label="Customer" column="customerName" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  <SortHeader label="Reference" column="customerReference" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  <SortHeader label="Order Date" column="orderDate" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                  <SortHeader
                    label="Backordered"
                    column="totalBackorderQty"
                    align="right"
                    sortColumn={sortColumn}
                    sortDirection={sortDirection}
                    onSort={handleSort}
                  />
                </tr>
              </thead>
              <tbody>
                {sortedBackorderedSales.map((sale) => (
                  <tr key={sale.cin7SaleId} className="border-b border-slate-100 hover:bg-slate-50">
                    <td className="py-1.5 pr-4">
                      <input
                        type="checkbox"
                        aria-label={`Exclude order ${sale.orderNumber ?? sale.cin7SaleId}`}
                        checked={excludedSaleIds.has(sale.cin7SaleId)}
                        onChange={() => toggleExcluded(sale.cin7SaleId)}
                        className="h-4 w-4 rounded border-slate-300 text-primary"
                      />
                    </td>
                    <td className="py-1.5 pr-4 font-medium text-slate-900">{sale.orderNumber ?? sale.cin7SaleId}</td>
                    <td className="py-1.5 pr-4 text-slate-600">{sale.customerName ?? <span className="text-slate-300">—</span>}</td>
                    <td className="py-1.5 pr-4 text-slate-500">{sale.customerReference ?? <span className="text-slate-300">—</span>}</td>
                    <td className="py-1.5 pr-4 text-slate-500">{sale.orderDate ?? <span className="text-slate-300">—</span>}</td>
                    <td className="py-1.5 pr-4 text-right text-slate-500">{qty(sale.totalBackorderQty)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {lines && (
        <Panel className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <p className="font-medium text-slate-900">
              {lines.length} line{lines.length === 1 ? "" : "s"} — {lines.filter((l) => l.action === "Zero").length} Zero,{" "}
              {lines.filter((l) => l.action === "NonZero").length} NonZero
              {excludedSaleIds.size > 0 && ` (${excludedSaleIds.size} sale${excludedSaleIds.size === 1 ? "" : "s"} excluded)`}
            </p>
            <SearchInput value={search} onChange={setSearch} placeholder="Product name or SKU" />
            {lines.length > 0 && (
              <div className="flex gap-2">
                <Button variant="secondary" size="sm" onClick={handleDownloadIncludedSales} disabled={includedSales.length === 0} loading={isDownloadingIncludedSales}>
                  {isDownloadingIncludedSales ? "Preparing…" : "Export included sales"}
                </Button>
                <Button variant="secondary" size="sm" onClick={handleDownload} loading={isDownloading}>
                  {isDownloading ? "Preparing…" : "Download CSV"}
                </Button>
              </div>
            )}
          </div>
          {downloadError && (
            <div className="mt-2">
              <Alert tone="danger">{downloadError}</Alert>
            </div>
          )}
          {downloadedFilename && (
            <div className="mt-2">
              <Alert tone="success">
                Downloaded {downloadedFilename} — review it, then import it into Cin7&rsquo;s Bulk Stock Adjustment screen yourself.
              </Alert>
            </div>
          )}
          {includedSalesError && (
            <div className="mt-2">
              <Alert tone="danger">{includedSalesError}</Alert>
            </div>
          )}
          {includedSalesFilename && (
            <div className="mt-2">
              <Alert tone="success">
                Downloaded {includedSalesFilename} — {includedSales.length} sale{includedSales.length === 1 ? "" : "s"} this cleanup run assumed would become fulfillable.
              </Alert>
            </div>
          )}

          {missingCostSkus.length > 0 && (
            <div className="mt-3">
              <Alert tone="warning">
                {missingCostSkus.length} SKU{missingCostSkus.length === 1 ? " has" : "s have"} no average cost on file, so its
                UnitCost is blank below — fill it in by hand before importing: {missingCostSkus.join(", ")}
              </Alert>
            </div>
          )}

          {lines.length === 0 && (
            <div className="mt-4">
              <EmptyState
                title={excludedSaleIds.size > 0 ? "Nothing left to correct" : "Nothing oversold"}
                description={
                  excludedSaleIds.size > 0
                    ? "Every remaining shortfall was covered by excluded sales."
                    : "Nothing is currently oversold on this instance."
                }
              />
            </div>
          )}
          {lines.length > 0 && visibleLines.length === 0 && <p className="mt-4 text-sm text-slate-500">Nothing matches &ldquo;{search}&rdquo;.</p>}

          {visibleLines.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="border-b-2 border-slate-300 bg-slate-50">
                  <tr>
                    <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-slate-600">Action</th>
                    <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-slate-600">Product</th>
                    <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-slate-600">Location</th>
                    <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-slate-600">Bin</th>
                    <th scope="col" className="py-2 pr-4 text-xs font-semibold uppercase tracking-wide text-slate-600">Batch/SN</th>
                    <th scope="col" className="py-2 pr-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">Quantity</th>
                    <th scope="col" className="py-2 pr-4 text-right text-xs font-semibold uppercase tracking-wide text-slate-600">Unit Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleLines.map((line, i) => (
                    <tr key={i} className="border-b border-slate-100">
                      <td className="py-2 pr-4">
                        <Badge tone={line.action === "Zero" ? "warning" : "neutral"}>{line.action}</Badge>
                      </td>
                      <td className="py-2 pr-4">
                        <div className="font-medium text-slate-900">{line.productName ?? line.productSku}</div>
                        <div className="font-mono text-xs text-slate-500">{line.productSku}</div>
                      </td>
                      <td className="py-2 pr-4">{line.location ?? <span className="text-slate-300">—</span>}</td>
                      <td className="py-2 pr-4">{line.bin ?? <span className="text-slate-300">—</span>}</td>
                      <td className="py-2 pr-4">{line.batchSn ?? <span className="text-slate-300">—</span>}</td>
                      <td className="py-2 pr-4 text-right font-medium tabular-nums">{qty(line.quantity)}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {line.unitCost === null ? <span className="text-slate-300">—</span> : line.unitCost.toFixed(2)}
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
