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
import {
  listInstancesForPicker,
  type InstancePickerItem,
} from "@/actions/instances";
import {
  COST_BASIS_OPTIONS,
  type CostBasis,
  type AssemblyCostEstimate,
} from "@/costing/estimate";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";

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
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [instanceId, setInstanceId] = useState<string | null>(null);

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

  function handleLoadInstances() {
    setInstancesError(null);
    startLoadTransition(async () => {
      const res = await listInstancesForPicker();
      if (!res.ok) {
        setInstancesError(res.error ?? "Unknown error");
        return;
      }
      setInstances(res.instances ?? []);
    });
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
      const result = await action(estimates);
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
      const result = await action(productionResult.estimates);
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

  const productionEstimates = productionResult?.estimates ?? [];
  const totalAcrossProduction = productionEstimates.reduce(
    (sum, e) => sum + (e.totalCost ?? 0),
    0,
  );
  const incompleteProductionCount = productionEstimates.filter(
    (e) => !e.complete,
  ).length;

  return (
    <>
      <div className="mb-6 flex gap-2">
        {BOM_KIND_TABS.map((tab) => (
          <button
            key={tab.value}
            type="button"
            onClick={() => setBomKind(tab.value)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
              bomKind === tab.value
                ? "bg-indigo-600 text-white"
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

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Instance</p>
        <div className="mt-3">
          <button
            type="button"
            onClick={handleLoadInstances}
            disabled={isLoadingInstances}
            className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isLoadingInstances && <Spinner className="mr-1.5" />}
            {isLoadingInstances ? "Loading…" : "Load instances"}
          </button>
          {instancesError && (
            <p className="mt-2 text-sm text-red-600">{instancesError}</p>
          )}
          {instances.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {instances.map((inst) => (
                <label
                  key={inst.id}
                  className="flex items-center gap-2 text-base"
                >
                  <input
                    type="radio"
                    name="cost-estimator-instance"
                    checked={instanceId === inst.id}
                    onChange={() => setInstanceId(inst.id)}
                    disabled={!inst.active}
                    className="h-4 w-4"
                  />
                  {inst.name}{" "}
                  {!inst.active && (
                    <span className="text-sm text-slate-400">(inactive)</span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>
      </section>

      {bomKind === "assembly" ? (
        <>
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="font-medium text-slate-900">Cost basis</p>
            <div className="mt-2 flex flex-wrap gap-3 text-sm">
              {COST_BASIS_OPTIONS.map((opt) => (
                <label key={opt.value} className="flex items-center gap-1.5">
                  <input
                    type="radio"
                    name="cost-basis"
                    checked={basis === opt.value}
                    onChange={() => handleBasisChange(opt.value)}
                    className="h-4 w-4"
                  />
                  {opt.label}
                </label>
              ))}
            </div>

            <button
              type="button"
              onClick={() => handleScan()}
              disabled={isScanning || !instanceId}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isScanning && <Spinner className="mr-1.5" />}
              {isScanning ? "Estimating…" : "Estimate costs"}
            </button>
            {scanError && (
              <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {scanError}
              </p>
            )}
          </section>

          {estimates && (
            <section className="mt-6 flex flex-col gap-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm text-slate-500">
                  {estimates.length} assembl
                  {estimates.length === 1 ? "y" : "ies"} · basis:{" "}
                  {COST_BASIS_OPTIONS.find((o) => o.value === basis)?.label}
                </p>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-medium text-slate-700">
                    Total across all: {formatNumber(totalAcrossAssemblies)}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleExport("summary")}
                    disabled={isExporting || estimates.length === 0}
                    className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {isExporting ? "Exporting…" : "Export summary .xlsx"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExport("detail")}
                    disabled={isExporting || estimates.length === 0}
                    className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {isExporting ? "Exporting…" : "Export detail .xlsx"}
                  </button>
                </div>
              </div>
              {incompleteCount > 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {incompleteCount} assembl
                  {incompleteCount === 1 ? "y is" : "ies are"} missing cost data
                  for at least one component under this basis — those totals are
                  partial, not zero-cost.
                </p>
              )}
              {exportError && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {exportError}
                </p>
              )}

              {estimates.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                  <table className="w-full text-left text-sm text-slate-700">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                        <th className="w-8 px-2 py-2"></th>
                        <th className="px-4 py-2 font-medium">Assembly</th>
                        <th className="px-4 py-2 text-right font-medium">
                          Components
                        </th>
                        <th className="px-4 py-2 text-right font-medium">
                          Total Cost
                        </th>
                        <th className="px-4 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {estimates.map((estimate) => {
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
                                <span className="text-xs text-slate-400">
                                  ({estimate.assemblySku})
                                </span>
                              </td>
                              <td className="px-4 py-2 align-top text-right">
                                {estimate.lines.length}
                              </td>
                              <td className="px-4 py-2 align-top text-right">
                                {estimate.totalCost !== null
                                  ? formatNumber(estimate.totalCost)
                                  : "N/A"}
                              </td>
                              <td className="px-4 py-2 align-top">
                                {estimate.complete ? (
                                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                                    Complete
                                  </span>
                                ) : (
                                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                                    {estimate.missingCostCount} missing
                                  </span>
                                )}
                              </td>
                            </tr>
                            {isExpanded && (
                              <tr className="border-b border-slate-100 bg-slate-50 last:border-0">
                                <td colSpan={5} className="px-4 py-4">
                                  <table className="w-full text-left text-sm text-slate-700">
                                    <thead>
                                      <tr className="text-xs uppercase tracking-wide text-slate-400">
                                        <th className="py-1 pr-4 font-medium">
                                          Component
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
                                          Quantity
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
                                          Wastage
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
                                          Unit Cost
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
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
                                            <span className="text-xs text-slate-400">
                                              ({line.componentSku})
                                            </span>
                                          </td>
                                          <td className="py-1 pr-4 text-right">
                                            {formatNumber(line.quantity)}
                                          </td>
                                          <td className="py-1 pr-4 text-right">
                                            {formatNumber(line.wastageQuantity)}
                                          </td>
                                          <td className="py-1 pr-4 text-right">
                                            {line.unitCost !== null
                                              ? formatNumber(line.unitCost)
                                              : "N/A"}
                                          </td>
                                          <td className="py-1 pr-4 text-right">
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
                <p className="text-base text-slate-500">
                  No Assembly BOMs found on this instance.
                </p>
              )}
            </section>
          )}
        </>
      ) : (
        <>
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <p className="font-medium text-slate-900">Cost basis</p>
            <p className="mt-1 text-xs text-slate-400">
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
                    className="h-4 w-4"
                  />
                  {opt.label}
                </label>
              ))}
            </div>

            <button
              type="button"
              onClick={() => handleScanProduction()}
              disabled={isScanningProduction || !instanceId}
              className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isScanningProduction && <Spinner className="mr-1.5" />}
              {isScanningProduction ? "Estimating…" : "Estimate costs"}
            </button>
            {productionScanError && (
              <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                {productionScanError}
              </p>
            )}
          </section>

          {productionResult && (
            <section className="mt-6 flex flex-col gap-4">
              {productionResult.skippedNoOrder > 0 && (
                <p className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
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
                </p>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm text-slate-500">
                  {productionEstimates.length} product
                  {productionEstimates.length === 1 ? "" : "s"} · basis:{" "}
                  {COST_BASIS_OPTIONS.find((o) => o.value === basis)?.label}
                </p>
                <div className="flex items-center gap-3">
                  <p className="text-sm font-medium text-slate-700">
                    Total across all: {formatNumber(totalAcrossProduction)}
                  </p>
                  <button
                    type="button"
                    onClick={() => handleExportProduction("summary")}
                    disabled={
                      isExportingProduction || productionEstimates.length === 0
                    }
                    className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {isExportingProduction
                      ? "Exporting…"
                      : "Export summary .xlsx"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExportProduction("detail")}
                    disabled={
                      isExportingProduction || productionEstimates.length === 0
                    }
                    className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    {isExportingProduction
                      ? "Exporting…"
                      : "Export detail .xlsx"}
                  </button>
                </div>
              </div>
              {incompleteProductionCount > 0 && (
                <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
                  {incompleteProductionCount} product
                  {incompleteProductionCount === 1 ? " is" : "s are"} missing
                  cost data for at least one component under this basis — those
                  totals are partial, not zero-cost.
                </p>
              )}
              {productionExportError && (
                <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                  {productionExportError}
                </p>
              )}

              {productionEstimates.length > 0 ? (
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
                  <table className="w-full text-left text-sm text-slate-700">
                    <thead>
                      <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                        <th className="w-8 px-2 py-2"></th>
                        <th className="px-4 py-2 font-medium">Product</th>
                        <th className="px-4 py-2 text-right font-medium">
                          Components
                        </th>
                        <th className="px-4 py-2 text-right font-medium">
                          Resources
                        </th>
                        <th className="px-4 py-2 text-right font-medium">
                          Total Cost
                        </th>
                        <th className="px-4 py-2 font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {productionEstimates.map((estimate) => {
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
                                <span className="text-xs text-slate-400">
                                  ({estimate.productSku})
                                </span>
                                <div className="text-xs text-slate-400">
                                  Source: {estimate.sourceOrderNumber}
                                  {estimate.sourceOrderCompletionDate
                                    ? ` (completed ${estimate.sourceOrderCompletionDate.slice(0, 10)})`
                                    : ""}
                                </div>
                              </td>
                              <td className="px-4 py-2 align-top text-right">
                                {estimate.componentLines.length}
                              </td>
                              <td className="px-4 py-2 align-top text-right">
                                {estimate.resourceLines.length}
                              </td>
                              <td className="px-4 py-2 align-top text-right">
                                {estimate.totalCost !== null
                                  ? formatNumber(estimate.totalCost)
                                  : "N/A"}
                              </td>
                              <td className="px-4 py-2 align-top">
                                {estimate.complete ? (
                                  <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-semibold text-emerald-800">
                                    Complete
                                  </span>
                                ) : (
                                  <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                                    {estimate.missingCostCount} missing
                                  </span>
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
                                      <tr className="text-xs uppercase tracking-wide text-slate-400">
                                        <th className="py-1 pr-4 font-medium">
                                          Component
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
                                          Quantity
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
                                          Wastage
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
                                          Unit Cost
                                        </th>
                                        <th className="py-1 pr-4 text-right font-medium">
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
                                              <span className="text-xs text-slate-400">
                                                ({line.componentSku})
                                              </span>
                                            </td>
                                            <td className="py-1 pr-4 text-right">
                                              {formatNumber(line.quantity)}
                                            </td>
                                            <td className="py-1 pr-4 text-right">
                                              {formatNumber(
                                                line.wastageQuantity,
                                              )}
                                            </td>
                                            <td className="py-1 pr-4 text-right">
                                              {line.unitCost !== null
                                                ? formatNumber(line.unitCost)
                                                : "N/A"}
                                            </td>
                                            <td className="py-1 pr-4 text-right">
                                              {line.lineCost !== null
                                                ? formatNumber(line.lineCost)
                                                : "N/A"}
                                            </td>
                                          </tr>
                                        ),
                                      )}
                                    </tbody>
                                  </table>

                                  <p className="mb-2 mt-4 text-xs font-semibold uppercase tracking-wide text-slate-400">
                                    Resources
                                  </p>
                                  {estimate.resourceLines.length > 0 ? (
                                    <table className="w-full text-left text-sm text-slate-700">
                                      <thead>
                                        <tr className="text-xs uppercase tracking-wide text-slate-400">
                                          <th className="py-1 pr-4 font-medium">
                                            Resource
                                          </th>
                                          <th className="py-1 pr-4 text-right font-medium">
                                            Quantity
                                          </th>
                                          <th className="py-1 pr-4 text-right font-medium">
                                            Cost
                                          </th>
                                          <th className="py-1 pr-4 text-right font-medium">
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
                                                <span className="text-xs text-slate-400">
                                                  ({line.resourceCode})
                                                </span>
                                              </td>
                                              <td className="py-1 pr-4 text-right">
                                                {formatNumber(line.quantity)}
                                              </td>
                                              <td className="py-1 pr-4 text-right">
                                                {line.cost !== null
                                                  ? formatNumber(line.cost)
                                                  : "N/A"}
                                              </td>
                                              <td className="py-1 pr-4 text-right">
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
                <p className="text-base text-slate-500">
                  No Production BOM products with a completed Manufacture Order
                  were found on this instance.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </>
  );
}
