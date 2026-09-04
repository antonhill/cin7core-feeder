"use client";

import { Fragment, useState, useTransition } from "react";
import {
  getCostEstimatesAction,
  exportCostEstimatesAction,
  exportCostEstimatesSummaryAction,
  getProductionCostEstimatesAction,
  exportProductionCostEstimatesAction,
  exportProductionCostEstimatesSummaryAction,
  type ProductionCostEstimatorResult,
} from "./actions";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import {
  COST_BASIS_OPTIONS,
  type CostBasis,
  type AssemblyCostEstimate,
} from "@/costing/estimate";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { matchesSearch } from "../text-search";
import { SearchInput } from "../search-input";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "../ReportDescription";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { EmptyState } from "@/components/ui/EmptyState";

type AssemblySortColumn = "assembly" | "components" | "totalCost" | "status";

function assemblyEstimateSortValue(e: AssemblyCostEstimate, column: AssemblySortColumn): string | number | null {
  switch (column) {
    case "assembly":
      return e.assemblyName || e.assemblySku;
    case "components":
      return e.lines.length;
    case "totalCost":
      return e.totalCost;
    case "status":
      return e.missingCostCount;
  }
}

type ProductionSortColumn = "product" | "components" | "resources" | "totalCost" | "status";

function productionEstimateSortValue(e: ProductionCostEstimatorResult["estimates"][number], column: ProductionSortColumn): string | number | null {
  switch (column) {
    case "product":
      return e.productName || e.productSku;
    case "components":
      return e.componentLines.length;
    case "resources":
      return e.resourceLines.length;
    case "totalCost":
      return e.totalCost;
    case "status":
      return e.missingCostCount;
  }
}

/** Decodes the base64 .xlsx bytes the server rendered and triggers a normal browser download — same pattern as reports/page.tsx's downloadBase64File. */
function downloadBase64File(
  base64: string,
  filename: string,
  mimeType: string,
) {
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

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type BomKind = "assembly" | "production";

const BOM_KIND_TABS: { value: BomKind; label: string }[] = [
  { value: "assembly", label: "Assembly BOMs" },
  { value: "production", label: "Production BOMs" },
];

export default function CostEstimatorPage() {
  const [bomKind, setBomKind] = useState<BomKind>("assembly");
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [basis, setBasis] = useState<CostBasis>("average");

  const [estimates, setEstimates] = useState<AssemblyCostEstimate[] | null>(
    null,
  );
  const [scanError, setScanError] = useState<string | null>(null);
  const [isScanning, startScanTransition] = useTransition();
  const [expandedSkus, setExpandedSkus] = useState<Set<string>>(new Set());
  const [exportError, setExportError] = useState<string | null>(null);
  const [isExporting, startExportTransition] = useTransition();

  const [productionResult, setProductionResult] =
    useState<ProductionCostEstimatorResult | null>(null);
  const [productionScanError, setProductionScanError] = useState<string | null>(
    null,
  );
  const [isScanningProduction, startScanProductionTransition] = useTransition();
  const [expandedProductionSkus, setExpandedProductionSkus] = useState<
    Set<string>
  >(new Set());
  const [productionExportError, setProductionExportError] = useState<
    string | null
  >(null);
  const [isExportingProduction, startExportProductionTransition] =
    useTransition();

  const [sortColumn, setSortColumn] = useState<AssemblySortColumn>("assembly");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [assemblySearch, setAssemblySearch] = useState("");

  function handleSort(column: AssemblySortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const [productionSortColumn, setProductionSortColumn] = useState<ProductionSortColumn>("product");
  const [productionSortDirection, setProductionSortDirection] = useState<SortDirection>("asc");
  const [productionSearch, setProductionSearch] = useState("");

  function handleProductionSort(column: ProductionSortColumn) {
    if (column === productionSortColumn) setProductionSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setProductionSortColumn(column);
      setProductionSortDirection("asc");
    }
  }

  function handleScan(nextBasis: CostBasis = basis) {
    if (!instanceId) return;
    setScanError(null);
    setEstimates(null);
    setExpandedSkus(new Set());
    startScanTransition(async () => {
      const res = await getCostEstimatesAction(instanceId, nextBasis);
      if (!res.ok) {
        setScanError(res.error ?? "Unknown error");
        return;
      }
      setEstimates(res.data ?? []);
    });
  }

  function handleScanProduction(nextBasis: CostBasis = basis) {
    if (!instanceId) return;
    setProductionScanError(null);
    setProductionResult(null);
    setExpandedProductionSkus(new Set());
    startScanProductionTransition(async () => {
      const res = await getProductionCostEstimatesAction(instanceId, nextBasis);
      if (!res.ok) {
        setProductionScanError(res.error ?? "Unknown error");
        return;
      }
      setProductionResult(res.data ?? null);
    });
  }

  function handleBasisChange(nextBasis: CostBasis) {
    setBasis(nextBasis);
    if (bomKind === "assembly") {
      if (estimates) handleScan(nextBasis);
    } else {
      if (productionResult) handleScanProduction(nextBasis);
    }
  }

  function toggleExpand(sku: string) {
    setExpandedSkus((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function toggleExpandProduction(sku: string) {
    setExpandedProductionSkus((prev) => {
      const next = new Set(prev);
      if (next.has(sku)) next.delete(sku);
      else next.add(sku);
      return next;
    });
  }

  function handleExport(kind: "detail" | "summary") {
    if (!estimates) return;
    setExportError(null);
    startExportTransition(async () => {
      const action =
        kind === "detail"
          ? exportCostEstimatesAction
          : exportCostEstimatesSummaryAction;
      const result = await action(sortedEstimates);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      const suffix = kind === "summary" ? "-summary" : "";
      downloadBase64File(
        result.data,
        `cost-estimate-${basis}${suffix}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });
  }

  function handleExportProduction(kind: "detail" | "summary") {
    if (!productionResult || productionResult.estimates.length === 0) return;
    setProductionExportError(null);
    startExportProductionTransition(async () => {
      const action =
        kind === "detail"
          ? exportProductionCostEstimatesAction
          : exportProductionCostEstimatesSummaryAction;
      const result = await action(sortedProductionEstimates);
      if (!result.ok || !result.data) {
        setProductionExportError(result.error ?? "Unknown error");
        return;
      }
      const suffix = kind === "summary" ? "-summary" : "";
      downloadBase64File(
        result.data,
        `production-cost-estimate-${basis}${suffix}.xlsx`,
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
    });
  }

  const totalAcrossAssemblies = (estimates ?? []).reduce(
    (sum, e) => sum + (e.totalCost ?? 0),
    0,
  );
  const incompleteCount = (estimates ?? []).filter((e) => !e.complete).length;

  // Plain derived values, not useMemo — this page only re-renders on user
  // actions (scan/sort clicks), not continuously, so re-sorting each render
  // is negligible; the React Compiler couldn't preserve manual memoization
  // here anyway (some other pre-existing pattern in this large file blocks
  // its auto-optimization pass).
  const sortedEstimates = [...(estimates ?? [])]
    .filter((e) => matchesSearch(assemblySearch, e.assemblySku, e.assemblyName))
    .sort((a, b) => {
      const cmp = compareNullable(assemblyEstimateSortValue(a, sortColumn), assemblyEstimateSortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });

  const productionEstimates = productionResult?.estimates ?? [];
  const totalAcrossProduction = productionEstimates.reduce(
    (sum, e) => sum + (e.totalCost ?? 0),
    0,
  );
  const incompleteProductionCount = productionEstimates.filter(
    (e) => !e.complete,
  ).length;

  const sortedProductionEstimates = [...productionEstimates]
    .filter((e) => matchesSearch(productionSearch, e.productSku, e.productName))
    .sort((a, b) => {
      const cmp = compareNullable(productionEstimateSortValue(a, productionSortColumn), productionEstimateSortValue(b, productionSortColumn));
      return productionSortDirection === "asc" ? cmp : -cmp;
    });

  return (
    <>
      <ReportDescription title="Production Cost Estimator">
        Re-prices every Assembly or Production BOM&rsquo;s components under Average, Latest, or Fixed cost — not
        whatever cost happened to be baked in when the BOM was last built. Cin7 Core&rsquo;s own costing reflects
        historical build-time costs; this shows what an assembly or production run would cost to build today, which
        is what actually drives selling-price decisions.
      </ReportDescription>
      <div className="mb-6 flex gap-2">
        {BOM_KIND_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setBomKind(tab.value)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              bomKind === tab.value
                ? "bg-primary text-white"
                : "border border-slate-300 text-slate-600 hover:bg-slate-50"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />
      <PageLoadingIndicator
        show={isExportingProduction}
        label="Exporting to Excel…"
      />

      <Panel>
        <PanelTitle>Instance</PanelTitle>
        <div className="mt-3">
          <InstancePicker {...picker} onChange={picker.setInstanceId} />
        </div>
      </Panel>

      {bomKind === "assembly" ? (
        <>
          <Panel className="mt-6">
            <PanelTitle>Cost basis</PanelTitle>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {COST_BASIS_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="cost-basis"
                    checked={basis === opt.value}
                    onChange={() => handleBasisChange(opt.value)}
                    className="h-4 w-4 text-primary"
                  />
                  {opt.label}
                </label>
              ))}
            </div>

            <Button onClick={() => handleScan()} disabled={!instanceId} loading={isScanning} className="mt-4">
              {isScanning ? "Estimating…" : "Estimate costs"}
            </Button>
            {scanError && (
              <div className="mt-4">
                <Alert tone="danger">{scanError}</Alert>
              </div>
            )}
          </Panel>

          {estimates && (
            <section className="mt-6 flex flex-col gap-4">
              <Panel className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-500">
                  {sortedEstimates.length} of {estimates.length} assembl
                  {estimates.length === 1 ? "y" : "ies"} · basis:{" "}
                  {COST_BASIS_OPTIONS.find((o) => o.value === basis)?.label}
                </p>
                <SearchInput value={assemblySearch} onChange={setAssemblySearch} placeholder="Assembly SKU or name" />
                <div className="flex items-center gap-3">
                  <p className="text-sm font-medium text-slate-700 tabular-nums">
                    Total across all: {formatNumber(totalAcrossAssemblies)}
                  </p>
                  <Button variant="secondary" size="sm" onClick={() => handleExport("summary")} disabled={estimates.length === 0} loading={isExporting}>
                    {isExporting ? "Exporting…" : "Export summary .xlsx"}
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => handleExport("detail")} disabled={estimates.length === 0} loading={isExporting}>
                    {isExporting ? "Exporting…" : "Export detail .xlsx"}
                  </Button>
                </div>
              </Panel>
              {incompleteCount > 0 && (
                <Alert tone="warning">
                  {incompleteCount} assembl
                  {incompleteCount === 1 ? "y is" : "ies are"} missing cost data
                  for at least one component under this basis — those totals are
                  partial, not zero-cost.
                </Alert>
              )}
              {exportError && <Alert tone="danger">{exportError}</Alert>}

              {sortedEstimates.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-left text-sm text-slate-700">
                    <thead>
                      <tr className="border-b-2 border-slate-300 text-xs font-semibold uppercase tracking-wide text-slate-600">
                        <th className="w-8 px-2 py-2"></th>
                        <SortHeader label="Assembly" column="assembly" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                        <SortHeader
                          label="Components"
                          column="components"
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
                        <SortHeader label="Status" column="status" thClassName="px-4 py-2" sortColumn={sortColumn} sortDirection={sortDirection} onSort={handleSort} />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedEstimates.map((estimate) => {
                        const isExpanded = expandedSkus.has(
                          estimate.assemblySku,
                        );
                        return (
                          <Fragment key={estimate.assemblySku}>
                            <tr
                              onClick={() => toggleExpand(estimate.assemblySku)}
                              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                            >
                              <td className="px-2 py-2 align-top text-center text-slate-400">
                                {isExpanded ? "▾" : "▸"}
                              </td>
                              <td className="px-4 py-2 align-top">
                                {estimate.assemblyName || "—"}{" "}
                                <span className="font-mono text-xs text-slate-400">
                                  ({estimate.assemblySku})
                                </span>
                              </td>
                              <td className="px-4 py-2 align-top text-right tabular-nums">
                                {estimate.lines.length}
                              </td>
                              <td className="px-4 py-2 align-top text-right tabular-nums">
                                {estimate.totalCost !== null
                                  ? formatNumber(estimate.totalCost)
                                  : "N/A"}
                              </td>
                              <td className="px-4 py-2 align-top">
                                {estimate.complete ? (
                                  <Badge tone="success">Complete</Badge>
                                ) : (
                                  <Badge tone="warning">{estimate.missingCostCount} missing</Badge>
                                )}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="border-b border-slate-100 bg-slate-50 last:border-0">
                                <td colSpan={5} className="px-4 py-4">
                                  <table className="w-full text-left text-sm text-slate-700">
                                    <thead>
                                      <tr className="border-b border-slate-300 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                        <th className="py-1 pr-4">
                                          Component
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Quantity
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Wastage
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Unit Cost
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Line Cost
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {estimate.lines.map((line, i) => (
                                        <tr
                                          key={i}
                                          className="border-t border-slate-200"
                                        >
                                          <td className="py-1 pr-4">
                                            {line.componentName || "—"}{" "}
                                            <span className="font-mono text-xs text-slate-400">
                                              ({line.componentSku})
                                            </span>
                                          </td>
                                          <td className="py-1 pr-4 text-right tabular-nums">
                                            {formatNumber(line.quantity)}
                                          </td>
                                          <td className="py-1 pr-4 text-right tabular-nums">
                                            {formatNumber(line.wastageQuantity)}
                                          </td>
                                          <td className="py-1 pr-4 text-right tabular-nums">
                                            {line.unitCost !== null
                                              ? formatNumber(line.unitCost)
                                              : "N/A"}
                                          </td>
                                          <td className="py-1 pr-4 text-right tabular-nums">
                                            {line.lineCost !== null
                                              ? formatNumber(line.lineCost)
                                              : "N/A"}
                                          </td>
                                        </tr>
                                      ))}
                                    </tbody>
                                  </table>
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
                <EmptyState
                  title={estimates.length > 0 ? `Nothing matches "${assemblySearch}"` : "No Assembly BOMs found"}
                  description={estimates.length > 0 ? undefined : "No Assembly BOMs were found on this instance."}
                />
              )}
            </section>
          )}
        </>
      ) : (
        <>
          <Panel className="mt-6">
            <PanelTitle>Cost basis</PanelTitle>
            <p className="mt-1 text-xs text-slate-500">
              Applies to material Components only — Resources (labor/machine)
              are shown at whatever cost their source Manufacture Order itself
              reported, since Cin7 has no confirmed &ldquo;current resource
              rate&rdquo; to re-price against.
            </p>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {COST_BASIS_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="production-cost-basis"
                    checked={basis === opt.value}
                    onChange={() => handleBasisChange(opt.value)}
                    className="h-4 w-4 text-primary"
                  />
                  {opt.label}
                </label>
              ))}
            </div>

            <Button onClick={() => handleScanProduction()} disabled={!instanceId} loading={isScanningProduction} className="mt-4">
              {isScanningProduction ? "Estimating…" : "Estimate costs"}
            </Button>
            {productionScanError && (
              <div className="mt-4">
                <Alert tone="danger">{productionScanError}</Alert>
              </div>
            )}
          </Panel>

          {productionResult && (
            <section className="mt-6 flex flex-col gap-4">
              {productionResult.skippedNoOrder > 0 && (
                <Alert tone="info">
                  {productionResult.totalProductionSkus} Production BOM product
                  {productionResult.totalProductionSkus === 1 ? "" : "s"} found
                  on this instance — {productionEstimates.length} have at least
                  one completed Manufacture Order and can be estimated.{" "}
                  {productionResult.skippedNoOrder} have never been built and
                  {productionResult.skippedNoOrder === 1
                    ? " isn't"
                    : " aren't"}{" "}
                  shown, since a Production BOM&rsquo;s recipe can only be read
                  from a completed order.
                </Alert>
              )}
              <Panel className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-slate-500">
                  {sortedProductionEstimates.length} of {productionEstimates.length} product
                  {productionEstimates.length === 1 ? "" : "s"} · basis:{" "}
                  {COST_BASIS_OPTIONS.find((o) => o.value === basis)?.label}
                </p>
                <SearchInput value={productionSearch} onChange={setProductionSearch} placeholder="Product SKU or name" />
                <div className="flex items-center gap-3">
                  <p className="text-sm font-medium text-slate-700 tabular-nums">
                    Total across all: {formatNumber(totalAcrossProduction)}
                  </p>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleExportProduction("summary")}
                    disabled={productionEstimates.length === 0}
                    loading={isExportingProduction}
                  >
                    {isExportingProduction
                      ? "Exporting…"
                      : "Export summary .xlsx"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => handleExportProduction("detail")}
                    disabled={productionEstimates.length === 0}
                    loading={isExportingProduction}
                  >
                    {isExportingProduction
                      ? "Exporting…"
                      : "Export detail .xlsx"}
                  </Button>
                </div>
              </Panel>
              {incompleteProductionCount > 0 && (
                <Alert tone="warning">
                  {incompleteProductionCount} product
                  {incompleteProductionCount === 1 ? " is" : "s are"} missing
                  cost data for at least one component under this basis — those
                  totals are partial, not zero-cost.
                </Alert>
              )}
              {productionExportError && <Alert tone="danger">{productionExportError}</Alert>}

              {sortedProductionEstimates.length > 0 ? (
                <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
                  <table className="w-full text-left text-sm text-slate-700">
                    <thead>
                      <tr className="border-b-2 border-slate-300 text-xs font-semibold uppercase tracking-wide text-slate-600">
                        <th className="w-8 px-2 py-2"></th>
                        <SortHeader
                          label="Product"
                          column="product"
                          thClassName="px-4 py-2"
                          sortColumn={productionSortColumn}
                          sortDirection={productionSortDirection}
                          onSort={handleProductionSort}
                        />
                        <SortHeader
                          label="Components"
                          column="components"
                          align="right"
                          thClassName="px-4 py-2"
                          sortColumn={productionSortColumn}
                          sortDirection={productionSortDirection}
                          onSort={handleProductionSort}
                        />
                        <SortHeader
                          label="Resources"
                          column="resources"
                          align="right"
                          thClassName="px-4 py-2"
                          sortColumn={productionSortColumn}
                          sortDirection={productionSortDirection}
                          onSort={handleProductionSort}
                        />
                        <SortHeader
                          label="Total Cost"
                          column="totalCost"
                          align="right"
                          thClassName="px-4 py-2"
                          sortColumn={productionSortColumn}
                          sortDirection={productionSortDirection}
                          onSort={handleProductionSort}
                        />
                        <SortHeader
                          label="Status"
                          column="status"
                          thClassName="px-4 py-2"
                          sortColumn={productionSortColumn}
                          sortDirection={productionSortDirection}
                          onSort={handleProductionSort}
                        />
                      </tr>
                    </thead>
                    <tbody>
                      {sortedProductionEstimates.map((estimate) => {
                        const isExpanded = expandedProductionSkus.has(
                          estimate.productSku,
                        );
                        return (
                          <Fragment key={estimate.productSku}>
                            <tr
                              onClick={() =>
                                toggleExpandProduction(estimate.productSku)
                              }
                              className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50"
                            >
                              <td className="px-2 py-2 align-top text-center text-slate-400">
                                {isExpanded ? "▾" : "▸"}
                              </td>
                              <td className="px-4 py-2 align-top">
                                {estimate.productName || "—"}{" "}
                                <span className="font-mono text-xs text-slate-400">
                                  ({estimate.productSku})
                                </span>
                                <div className="text-xs text-slate-400">
                                  Source: {estimate.sourceOrderNumber}
                                  {estimate.sourceOrderCompletionDate
                                    ? ` (completed ${estimate.sourceOrderCompletionDate.slice(0, 10)})`
                                    : ""}
                                </div>
                              </td>
                              <td className="px-4 py-2 align-top text-right tabular-nums">
                                {estimate.componentLines.length}
                              </td>
                              <td className="px-4 py-2 align-top text-right tabular-nums">
                                {estimate.resourceLines.length}
                              </td>
                              <td className="px-4 py-2 align-top text-right tabular-nums">
                                {estimate.totalCost !== null
                                  ? formatNumber(estimate.totalCost)
                                  : "N/A"}
                              </td>
                              <td className="px-4 py-2 align-top">
                                {estimate.complete ? (
                                  <Badge tone="success">Complete</Badge>
                                ) : (
                                  <Badge tone="warning">{estimate.missingCostCount} missing</Badge>
                                )}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="border-b border-slate-100 bg-slate-50 last:border-0">
                                <td colSpan={6} className="px-4 py-4">
                                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
                                    Components
                                  </p>
                                  <table className="w-full text-left text-sm text-slate-700">
                                    <thead>
                                      <tr className="border-b border-slate-300 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                        <th className="py-1 pr-4">
                                          Component
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Quantity
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Wastage
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Unit Cost
                                        </th>
                                        <th className="py-1 pr-4 text-right">
                                          Line Cost
                                        </th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {estimate.componentLines.map(
                                        (line, i) => (
                                          <tr
                                            key={i}
                                            className="border-t border-slate-200"
                                          >
                                            <td className="py-1 pr-4">
                                              {line.componentName || "—"}{" "}
                                              <span className="font-mono text-xs text-slate-400">
                                                ({line.componentSku})
                                              </span>
                                            </td>
                                            <td className="py-1 pr-4 text-right tabular-nums">
                                              {formatNumber(line.quantity)}
                                            </td>
                                            <td className="py-1 pr-4 text-right tabular-nums">
                                              {formatNumber(
                                                line.wastageQuantity,
                                              )}
                                            </td>
                                            <td className="py-1 pr-4 text-right tabular-nums">
                                              {line.unitCost !== null
                                                ? formatNumber(line.unitCost)
                                                : "N/A"}
                                            </td>
                                            <td className="py-1 pr-4 text-right tabular-nums">
                                              {line.lineCost !== null
                                                ? formatNumber(line.lineCost)
                                                : "N/A"}
                                            </td>
                                          </tr>
                                        ),
                                      )}
                                    </tbody>
                                  </table>

                                  <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                    Resources
                                  </p>
                                  {estimate.resourceLines.length > 0 ? (
                                    <table className="w-full text-left text-sm text-slate-700">
                                      <thead>
                                        <tr className="border-b border-slate-300 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                          <th className="py-1 pr-4">
                                            Resource
                                          </th>
                                          <th className="py-1 pr-4">
                                            Step
                                          </th>
                                          <th className="py-1 pr-4">
                                            Cost Type
                                          </th>
                                          <th className="py-1 pr-4 text-right">
                                            Quantity
                                          </th>
                                          <th className="py-1 pr-4 text-right">
                                            Cost
                                          </th>
                                          <th className="py-1 pr-4 text-right">
                                            Total Cost
                                          </th>
                                        </tr>
                                      </thead>
                                      <tbody>
                                        {estimate.resourceLines.map(
                                          (line, i) => (
                                            <tr
                                              key={i}
                                              className="border-t border-slate-200"
                                            >
                                              <td className="py-1 pr-4">
                                                {line.resourceName || "—"}{" "}
                                                <span className="font-mono text-xs text-slate-400">
                                                  ({line.resourceCode})
                                                </span>
                                              </td>
                                              <td className="py-1 pr-4 text-slate-500">
                                                {line.stepName || "—"}
                                              </td>
                                              <td className="py-1 pr-4 text-slate-500">
                                                {line.costCalculationType ||
                                                  "—"}
                                              </td>
                                              <td className="py-1 pr-4 text-right tabular-nums">
                                                {formatNumber(line.quantity)}
                                              </td>
                                              <td className="py-1 pr-4 text-right tabular-nums">
                                                {line.cost !== null
                                                  ? formatNumber(line.cost)
                                                  : "N/A"}
                                              </td>
                                              <td className="py-1 pr-4 text-right tabular-nums">
                                                {line.totalCost !== null
                                                  ? formatNumber(line.totalCost)
                                                  : "N/A"}
                                              </td>
                                            </tr>
                                          ),
                                        )}
                                      </tbody>
                                    </table>
                                  ) : (
                                    <p className="text-xs text-slate-400">
                                      No labor/machine resources recorded on
                                      this order.
                                    </p>
                                  )}
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
                <EmptyState
                  title={productionEstimates.length > 0 ? `Nothing matches "${productionSearch}"` : "No Production BOM products found"}
                  description={
                    productionEstimates.length > 0
                      ? undefined
                      : "No Production BOM products with a completed Manufacture Order were found on this instance."
                  }
                />
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
