"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import { loadPoQuantityReportAction, exportPoQuantityXlsxAction } from "./actions";
import type { ReportFilterOptions } from "@/reports/query";
import type { PoQuantityReport } from "@/reports/po-quantity-query";
import {
  BACKFILL_MONTHS,
  DATA_QUALITY_LABEL,
  LINE_STATUS_LABEL,
  computeTrustedTotals,
  qualityGroup,
  type LineStatus,
  type PoQuantityRow,
} from "@/reports/po-quantity-comparison";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { matchesSearch } from "../text-search";
import { SearchInput } from "../search-input";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { InstanceMultiPicker } from "@/app/InstanceMultiPicker";
import { ReportDescription } from "../ReportDescription";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";

type SortColumn = "po" | "supplier" | "orderDate" | "poStatus" | "sku" | "ordered" | "received" | "outstanding" | "lineStatus";

const ROW_CAP = 500;

const LINE_TONE: Record<LineStatus, BadgeTone> = {
  fully_received: "success",
  partially_received: "warning",
  not_received: "neutral",
  over_received: "danger",
};

function sortValue(r: PoQuantityRow, c: SortColumn): string | number | null {
  switch (c) {
    case "po":
      return r.orderNumber;
    case "supplier":
      return r.supplierName;
    case "orderDate":
      return r.orderDate;
    case "poStatus":
      return r.poStatus;
    case "sku":
      return r.sku;
    case "lineStatus":
      return r.lineStatus ? LINE_STATUS_LABEL[r.lineStatus] : null;
    default:
      return r[c];
  }
}

function fmtQty(v: number | null): string {
  return v === null ? "—" : v.toLocaleString();
}

function fmtTs(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "never";
}

function downloadBase64File(base64: string, filename: string, mimeType: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** Outside the component body — Date.now()/new Date() are impure for the react-hooks/purity rule. */
function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

export default function PoQuantityComparisonPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [report, setReport] = useState<PoQuantityReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();
  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const [supplier, setSupplier] = useState("");
  const [poStatus, setPoStatus] = useState("");
  const [lineStatus, setLineStatus] = useState("");
  const [quality, setQuality] = useState("");
  const [poSearch, setPoSearch] = useState("");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);

  const [sortColumn, setSortColumn] = useState<SortColumn>("orderDate");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  useEffect(() => {
    loadReportFilterOptionsAction().then((result) => {
      if (!result.ok) setOptionsError(result.error ?? "Unknown error");
      else setOptions(result.data ?? null);
    });
  }, []);

  function handleSort(column: SortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleRun() {
    setReportError(null);
    setReport(null);
    setShowAll(false);
    startRunTransition(async () => {
      const result = await loadPoQuantityReportAction({
        instanceIds: instanceIds.length ? instanceIds : undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      if (!result.ok || !result.data) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setReport(result.data);
    });
  }

  const rows = useMemo(() => report?.rows ?? [], [report]);
  const suppliers = useMemo(() => [...new Set(rows.map((r) => r.supplierName).filter((v): v is string => Boolean(v)))].sort(), [rows]);
  const poStatuses = useMemo(() => [...new Set(rows.map((r) => r.poStatus).filter((v): v is string => Boolean(v)))].sort(), [rows]);

  const filteredRows = useMemo(
    () =>
      rows.filter((r) => {
        if (supplier && r.supplierName !== supplier) return false;
        if (poStatus && r.poStatus !== poStatus) return false;
        if (lineStatus && r.lineStatus !== lineStatus) return false;
        if (quality && qualityGroup(r.dataQuality) !== quality) return false;
        if (!matchesSearch(poSearch, r.orderNumber)) return false;
        return matchesSearch(search, r.sku, r.productName);
      }),
    [rows, supplier, poStatus, lineStatus, quality, poSearch, search]
  );

  const sortedRows = useMemo(() => {
    const copy = [...filteredRows];
    copy.sort((a, b) => {
      const cmp = compareNullable(sortValue(a, sortColumn), sortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [filteredRows, sortColumn, sortDirection]);

  const visibleRows = showAll ? sortedRows : sortedRows.slice(0, ROW_CAP);
  // Scope: the POs returned by the instance + date selection above (NOT the all-time per-instance sync table).
  const selection = computeTrustedTotals(rows);
  const incompletePoCount = selection.excludedPoCount.incomplete;
  const stalePoCount = selection.excludedPoCount.stale;
  const reviewPoCount = selection.excludedPoCount.review;
  const noProductLinesPoCount = selection.notApplicablePoCount;
  const trusted = computeTrustedTotals(sortedRows);
  const backfillCutoff = monthsAgoIso(BACKFILL_MONTHS);

  function handleExport() {
    setExportError(null);
    startExportTransition(async () => {
      // Export the full filtered+sorted set (not just the capped on-screen slice) so totals agree with the filters.
      const result = await exportPoQuantityXlsxAction(sortedRows);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "po-quantity-comparison.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  const th = (label: string, column: SortColumn, align: "left" | "right" = "left") => (
    <SortHeader label={label} column={column} align={align} sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
  );

  return (
    <>
      <ReportDescription title="PO Quantity Comparison">
        Compares the quantity ordered with the quantity received for each product on each purchase order, using the purchase data
        Toolbox has already synced from Cin7. Quantities are totalled per PO and SKU (several order lines for the same SKU are
        added together). Outstanding is Ordered − Received and goes negative when more than ordered has been received. Supplier
        invoices, credit notes and returns are not part of this report.
      </ReportDescription>
      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />

      <Panel>
        <PanelTitle>Filters</PanelTitle>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2">
              {options && <InstanceMultiPicker instances={options.instances} selectedIds={instanceIds} onToggle={toggleInstance} />}
            </div>
          </div>
          <Input label="Order date from" type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
          <Input label="Order date to" type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
        </div>
        <div className="mt-5">
          <Button onClick={handleRun} loading={isRunning}>
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

      {report && (
        <>
          <Panel className="mt-6">
            <PanelTitle>Data completeness</PanelTitle>
            <div className="mt-3 space-y-2">
              <Alert tone="warning">
                Not a complete record of every purchase order. Toolbox only holds POs updated in Cin7 within the 12 months before each
                instance&rsquo;s first purchase sync, plus any changed since; older POs and VOIDED POs are not cached.
                {dateFrom && dateFrom < backfillCutoff ? " Your date range starts more than 12 months ago — treat older results as partial." : ""}
              </Alert>
              {incompletePoCount > 0 && (
                <Alert tone="danger">
                  Incomplete — {incompletePoCount} PO{incompletePoCount === 1 ? "" : "s"} in this selection have no usable line detail yet (detail not synced, still failing,
                  or no lines cached). They are listed with blank quantities — not zero — and must not be read as &ldquo;nothing received&rdquo;.
                </Alert>
              )}
              {noProductLinesPoCount > 0 && (
                <Alert tone="info">
                  No product lines — {noProductLinesPoCount} PO{noProductLinesPoCount === 1 ? "" : "s"} in this selection are purchases with no product
                  lines (receiving NOT AVAILABLE in Cin7, e.g. Service Purchases with additional charges). There is nothing to compare, so
                  they are not counted as incomplete.
                </Alert>
              )}
              {stalePoCount > 0 && (
                <Alert tone="warning">
                  Potentially stale — {stalePoCount} PO{stalePoCount === 1 ? "" : "s"} in this selection (that have cached lines) changed in Cin7 after
                  their quantities were last fetched, so received quantities may be out of date. The regular sync does not refresh these.
                </Alert>
              )}
              {reviewPoCount > 0 && (
                <Alert tone="warning">
                  Needs review — {reviewPoCount} PO{reviewPoCount === 1 ? "" : "s"} in this selection where Cin7&rsquo;s receiving status and its received
                  lines disagree (e.g. FULLY RECEIVED but received below ordered). This can be a Cin7 data inconsistency, not necessarily a Toolbox
                  error — verify in Cin7. Shown, but not included in trusted totals.
                </Alert>
              )}
              {report.excludedNoOrderDate > 0 && (
                <Alert tone="warning">
                  {report.excludedNoOrderDate} cached PO{report.excludedNoOrderDate === 1 ? " has" : "s have"} no order date and{" "}
                  {report.excludedNoOrderDate === 1 ? "was" : "were"} excluded by the date filter.
                </Alert>
              )}
            </div>
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50">
                  <tr className="border-b-2 border-slate-300 text-slate-600">
                    <th className="py-2 pr-4">Instance</th>
                    <th className="py-2 pr-4 text-right">POs cached (all time)</th>
                    <th className="py-2 pr-4 text-right">Detail pending (all time)</th>
                    <th className="py-2 pr-4 text-right" title="All cached POs for the instance, including POs with no lines and POs outside the date selection">Potentially stale (all time, incl. no-line POs)</th>
                    <th className="py-2 pr-4">PO list last synced</th>
                    <th className="py-2 pr-4">Latest detail sync</th>
                    <th className="py-2 pr-4">Approx. cached from</th>
                  </tr>
                </thead>
                <tbody>
                  {report.sync.map((s) => (
                    <tr key={s.instanceId} className="border-b border-slate-100">
                      <td className="py-2 pr-4 font-medium text-slate-900">{s.instanceName}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{s.poCount}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{s.detailPending}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">{s.possiblyStale}</td>
                      <td className="py-2 pr-4">{fmtTs(s.lastListSyncedAt)}</td>
                      <td className="py-2 pr-4">{fmtTs(s.lastDetailSyncedAt)}</td>
                      <td className="py-2 pr-4">{s.approxCoverageFrom ?? "no POs cached"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel className="mt-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              <Select label="Supplier" value={supplier} onChange={(e) => setSupplier(e.target.value)}>
                <option value="">All suppliers</option>
                {suppliers.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
              <Select label="PO status" value={poStatus} onChange={(e) => setPoStatus(e.target.value)}>
                <option value="">All statuses</option>
                {poStatuses.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
              <Select label="Line status" value={lineStatus} onChange={(e) => setLineStatus(e.target.value)}>
                <option value="">All line statuses</option>
                {(Object.keys(LINE_STATUS_LABEL) as LineStatus[]).map((k) => (
                  <option key={k} value={k}>
                    {LINE_STATUS_LABEL[k]}
                  </option>
                ))}
              </Select>
              <Select label="Data quality" value={quality} onChange={(e) => setQuality(e.target.value)}>
                <option value="">All</option>
                <option value="complete">Complete</option>
                <option value="stale">Potentially stale</option>
                <option value="incomplete">Incomplete (no usable lines)</option>
                <option value="not_applicable">No product lines (service / charge-only)</option>
                <option value="review">Needs review (status vs received lines)</option>
              </Select>
              <SearchInput value={poSearch} onChange={setPoSearch} placeholder="PO number" />
              <SearchInput value={search} onChange={setSearch} placeholder="SKU or description" />
            </div>

            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p className="font-semibold text-slate-900">Trusted totals — Complete POs only (current filters)</p>
              <p className="mt-1 tabular-nums text-slate-700">
                {trusted.trustedPoCount} PO{trusted.trustedPoCount === 1 ? "" : "s"} · Ordered {trusted.ordered.toLocaleString()} · Received{" "}
                {trusted.received.toLocaleString()} · Outstanding {trusted.outstanding.toLocaleString()}
              </p>
              <p className="mt-1 text-xs text-slate-500">
                Excluded and never summed: {trusted.excludedPoCount.incomplete} incomplete, {trusted.excludedPoCount.stale} potentially stale,{" "}
                {trusted.excludedPoCount.review} needs-review PO{trusted.excludedPoCount.review === 1 ? "" : "s"}. Quantities are unit counts across SKUs
                (no unit-of-measure data is cached). Partially received POs cannot be checked for missing receipt lines, so Complete means
                &ldquo;no contradiction detected&rdquo;, not &ldquo;verified&rdquo;.
              </p>
            </div>

            <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
              <p className="text-base font-semibold text-slate-900">
                {filteredRows.length} row{filteredRows.length === 1 ? "" : "s"}
              </p>
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
                <EmptyState title="No purchase orders" description="No cached purchase orders match the instance and date selection." />
              </div>
            )}
            {rows.length > 0 && filteredRows.length === 0 && <p className="mt-2 text-sm text-slate-500">No rows match the current filters.</p>}

            {filteredRows.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead className="bg-slate-50">
                    <tr className="border-b-2 border-slate-300 text-slate-600">
                      {th("PO", "po")}
                      {th("Supplier", "supplier")}
                      {th("Order date", "orderDate")}
                      {th("PO status", "poStatus")}
                      {th("Product", "sku")}
                      {th("Ordered", "ordered", "right")}
                      {th("Received", "received", "right")}
                      {th("Outstanding", "outstanding", "right")}
                      {th("Line status", "lineStatus")}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r) => (
                      <tr key={r.key} className="border-b border-slate-100 align-top hover:bg-slate-50">
                        <td className="py-2 pr-4">
                          <div className="font-medium text-slate-900">{r.orderNumber ?? "—"}</div>
                          <div className="text-xs text-slate-500">{r.instanceName}</div>
                        </td>
                        <td className="py-2 pr-4">{r.supplierName ?? "—"}</td>
                        <td className="py-2 pr-4 whitespace-nowrap">{r.orderDate ?? "—"}</td>
                        <td className="py-2 pr-4">{r.poStatus ?? "—"}</td>
                        <td className="py-2 pr-4">
                          {r.sku ? (
                            <>
                              <div className="font-mono text-xs text-slate-900">{r.sku}</div>
                              <div className="text-slate-600">{r.productName}</div>
                              {r.orderLineCount > 1 && <div className="text-xs text-slate-500">{r.orderLineCount} order lines combined</div>}
                            </>
                          ) : (
                            <span className="text-slate-400">—</span>
                          )}
                        </td>
                        <td className="py-2 pr-4 text-right tabular-nums">{fmtQty(r.ordered)}</td>
                        <td className="py-2 pr-4 text-right tabular-nums">{fmtQty(r.received)}</td>
                        <td className={`py-2 pr-4 text-right font-medium tabular-nums ${r.outstanding !== null && r.outstanding < 0 ? "text-red-700" : ""}`}>
                          {fmtQty(r.outstanding)}
                        </td>
                        <td className="py-2 pr-4">
                          <div className="flex flex-wrap gap-1">
                            {r.lineStatus && <Badge tone={LINE_TONE[r.lineStatus]}>{LINE_STATUS_LABEL[r.lineStatus]}</Badge>}
                            {r.notOnOrder && <Badge tone="danger">Not on PO</Badge>}
                            {r.isDropShip && <Badge tone="neutral">Drop-ship</Badge>}
                            {r.dataQuality !== "ok" && (
                              <span title={r.dataQualityNote ?? undefined}>
                                <Badge tone={(r.dataQuality === "possibly_stale" || r.dataQuality === "status_mismatch" ? "warning" : r.dataQuality === "no_product_lines" ? "neutral" : "danger") as BadgeTone}>{DATA_QUALITY_LABEL[r.dataQuality]}</Badge>
                              </span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!showAll && sortedRows.length > ROW_CAP && (
                  <div className="mt-3">
                    <Button variant="secondary" size="sm" onClick={() => setShowAll(true)}>
                      Show all {sortedRows.length} rows (showing {ROW_CAP})
                    </Button>
                  </div>
                )}
              </div>
            )}
          </Panel>
        </>
      )}
    </>
  );
}
