"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import { getBillingStatusAction } from "@/actions/billing";
import { loadPricingPreviewAction, applyPriceUpdatesAction } from "./actions";
import type { PricingFetchResult } from "@/cin7/pricing";
import { filterPriceableProducts, buildPriceUpdateLines, type PriceUpdateMode, type PriceUpdateLine } from "@/pricing/build";
import type { ApplyFixesResult } from "@/audit/apply-fixes";
import { ModuleHeader } from "@/app/ModuleHeader";
import { PRICING_MODULE } from "@/app/module-nav";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";

function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PricingPage() {
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [instanceId, setInstanceId] = useState("");

  const [previewData, setPreviewData] = useState<PricingFetchResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, startPreviewTransition] = useTransition();

  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [supplierFilter, setSupplierFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const [tierIndex, setTierIndex] = useState(0);
  const [mode, setMode] = useState<PriceUpdateMode>("set");
  const [value, setValue] = useState("");

  const [canWrite, setCanWrite] = useState(true);
  const [, startBillingTransition] = useTransition();
  useEffect(() => {
    startBillingTransition(async () => {
      const res = await getBillingStatusAction();
      if (res.ok && res.data) setCanWrite(res.data.canWrite);
    });
  }, []);

  const [isApplying, startApplyTransition] = useTransition();
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<ApplyFixesResult | null>(null);

  const categories = useMemo(() => {
    if (!previewData) return [];
    return [...new Set(previewData.products.map((p) => p.category).filter((c): c is string => c !== null))].sort();
  }, [previewData]);

  const suppliers = useMemo(() => {
    if (!previewData) return [];
    return [...new Set(previewData.products.flatMap((p) => p.supplierNames))].sort();
  }, [previewData]);

  const filteredProducts = useMemo(() => {
    if (!previewData) return [];
    return filterPriceableProducts(previewData.products, categoryFilter, supplierFilter, search);
  }, [previewData, categoryFilter, supplierFilter, search]);

  const parsedValue = value.trim() === "" ? null : Number(value);
  const valueIsValid = parsedValue !== null && !Number.isNaN(parsedValue);

  // Recomputed instantly whenever the filters/tier/mode/value change — no
  // server round trip, since buildPriceUpdateLines is a pure function and
  // the preview action already handed over every raw ingredient it needs.
  // Every filtered product is a starting candidate here; per-line exclusion
  // (below) narrows which of these actually get pushed.
  const allCandidateLines = useMemo(() => {
    if (!valueIsValid) return [];
    const allIds = new Set(filteredProducts.map((p) => p.productId));
    return buildPriceUpdateLines(filteredProducts, allIds, tierIndex, mode, parsedValue as number);
  }, [filteredProducts, tierIndex, mode, parsedValue, valueIsValid]);

  // Same "drop stale exclusions against the currently visible set" pattern
  // as Replenish's line-selection checkboxes — a leftover exclusion from a
  // previous filter/tier/mode combination can't silently apply to an
  // unrelated product that happens to reuse the same id.
  const [rawExcludedProductIds, setRawExcludedProductIds] = useState<Set<string>>(new Set());
  const excludedProductIds = useMemo(() => {
    const visible = new Set(allCandidateLines.map((l) => l.productId));
    return new Set([...rawExcludedProductIds].filter((id) => visible.has(id)));
  }, [rawExcludedProductIds, allCandidateLines]);
  const selectedLines = useMemo(
    () => allCandidateLines.filter((l) => !excludedProductIds.has(l.productId)),
    [allCandidateLines, excludedProductIds]
  );

  function toggleLine(productId: string) {
    setRawExcludedProductIds((prev) => {
      const next = new Set(prev);
      if (next.has(productId)) next.delete(productId);
      else next.add(productId);
      return next;
    });
  }

  function toggleAllLines() {
    setRawExcludedProductIds(excludedProductIds.size === 0 ? new Set(allCandidateLines.map((l) => l.productId)) : new Set());
  }

  function toggleCategoryFilter(category: string) {
    setCategoryFilter((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  function toggleSupplierFilter(supplier: string) {
    setSupplierFilter((prev) => (prev.includes(supplier) ? prev.filter((s) => s !== supplier) : [...prev, supplier]));
  }

  function handleLoadInstances() {
    setInstancesError(null);
    startLoadTransition(async () => {
      const res = await listInstancesForPicker();
      if (!res.ok) {
        setInstancesError(res.error ?? "Unknown error");
        return;
      }
      setInstances(res.instances ?? []);
      if (res.instances?.length === 1) setInstanceId(res.instances[0].id);
    });
  }

  function handleLoadProducts() {
    if (!instanceId) return;
    setPreviewError(null);
    setApplyResult(null);
    setApplyError(null);
    setRawExcludedProductIds(new Set());
    setCategoryFilter([]);
    setSupplierFilter([]);
    setSearch("");
    setTierIndex(0);
    setValue("");
    startPreviewTransition(async () => {
      const result = await loadPricingPreviewAction(instanceId);
      if (!result.ok) {
        setPreviewError(result.error ?? "Unknown error");
        return;
      }
      setPreviewData(result.data ?? null);
    });
  }

  function handleApply() {
    if (!instanceId || selectedLines.length === 0 || !previewData) return;
    const tierLabel = previewData.tierLabels[tierIndex];
    if (!confirm(`Update "${tierLabel}" on ${selectedLines.length} product(s)? This writes directly to Cin7.`)) return;
    setApplyError(null);
    setApplyResult(null);
    startApplyTransition(async () => {
      const result = await applyPriceUpdatesAction(instanceId, tierLabel, selectedLines);
      if (!result.ok) {
        setApplyError(result.error ?? "Unknown error");
        return;
      }
      setApplyResult(result.data ?? null);
    });
  }

  const writeDisabled = isApplying || !canWrite;
  const tierLabel = previewData?.tierLabels[tierIndex] ?? "";

  return (
    <>
      <ModuleHeader module={PRICING_MODULE}>
        Filters one connected instance&rsquo;s live product catalog by Category, Supplier, and search, then bulk-updates
        one chosen price tier — set a single flat price across every selected product, or increase each product&rsquo;s
        own current price by a percentage. Writes directly to Cin7.
      </ModuleHeader>
      <PageLoadingIndicator show={isLoadingPreview} label="Loading products…" />

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2 flex items-center gap-3">
              <button
                type="button"
                onClick={handleLoadInstances}
                disabled={isLoadingInstances}
                className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {isLoadingInstances && <Spinner className="mr-1.5" />}
                {isLoadingInstances ? "Loading…" : "Load instances"}
              </button>
              {instances.length > 0 && (
                <select
                  value={instanceId}
                  onChange={(e) => setInstanceId(e.target.value)}
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
                >
                  <option value="">Choose an instance…</option>
                  {instances.map((inst) => (
                    <option key={inst.id} value={inst.id}>
                      {inst.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            {instancesError && <p className="mt-2 text-sm text-red-600">{instancesError}</p>}
          </div>
          <button
            type="button"
            onClick={handleLoadProducts}
            disabled={isLoadingPreview || !instanceId}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isLoadingPreview && <Spinner className="mr-1.5" />}
            {isLoadingPreview ? "Loading…" : "Load products"}
          </button>
        </div>
        {previewError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{previewError}</p>}
      </section>

      {previewData && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
            {categories.length > 0 && (
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">Category</p>
                  <div className="flex gap-3 text-xs text-indigo-600">
                    <button type="button" onClick={() => setCategoryFilter(categories)} className="hover:underline">
                      Select all
                    </button>
                    <button type="button" onClick={() => setCategoryFilter([])} className="hover:underline">
                      Clear
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                  {categories.map((cat) => (
                    <label key={cat} className="flex items-center gap-2">
                      <input type="checkbox" checked={categoryFilter.includes(cat)} onChange={() => toggleCategoryFilter(cat)} className="h-4 w-4" />
                      {cat}
                    </label>
                  ))}
                </div>
              </div>
            )}

            {suppliers.length > 0 && (
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">Supplier</p>
                  <div className="flex gap-3 text-xs text-indigo-600">
                    <button type="button" onClick={() => setSupplierFilter(suppliers)} className="hover:underline">
                      Select all
                    </button>
                    <button type="button" onClick={() => setSupplierFilter([])} className="hover:underline">
                      Clear
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                  {suppliers.map((sup) => (
                    <label key={sup} className="flex items-center gap-2">
                      <input type="checkbox" checked={supplierFilter.includes(sup)} onChange={() => toggleSupplierFilter(sup)} className="h-4 w-4" />
                      {sup}
                    </label>
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1">
              <p className="text-sm font-medium text-slate-700">Search</p>
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Part of a SKU or product name…"
                className="mt-2 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
              <p className="mt-2 text-xs text-slate-400">{filteredProducts.length} product(s) match.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-b border-slate-100 py-4">
            <div>
              <p className="text-sm font-medium text-slate-700">Price tier</p>
              <select
                value={tierIndex}
                onChange={(e) => setTierIndex(Number(e.target.value))}
                className="mt-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                {previewData.tierLabels.map((label, i) => (
                  <option key={label} value={i}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="text-sm font-medium text-slate-700">Mode</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode("set")}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                    mode === "set" ? "border-indigo-600 bg-indigo-50 text-indigo-700" : "border-slate-300 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Set exact price
                </button>
                <button
                  type="button"
                  onClick={() => setMode("increase_percent")}
                  className={`rounded-full border px-3 py-1.5 text-sm font-medium ${
                    mode === "increase_percent" ? "border-indigo-600 bg-indigo-50 text-indigo-700" : "border-slate-300 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Increase by %
                </button>
              </div>
            </div>

            <div>
              <p className="text-sm font-medium text-slate-700">{mode === "set" ? "New price" : "% increase"}</p>
              <input
                type="number"
                step="0.01"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={mode === "set" ? "e.g. 99.99" : "e.g. 10"}
                className="mt-2 w-32 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>

            {selectedLines.length > 0 && (
              <button
                type="button"
                onClick={handleApply}
                disabled={writeDisabled}
                title={!canWrite ? "Writing to Cin7 is disabled on your current plan." : undefined}
                className="ml-auto rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
              >
                {isApplying && <Spinner className="mr-1.5" />}
                {isApplying ? "Updating…" : `Update ${selectedLines.length} product${selectedLines.length === 1 ? "" : "s"}`}
              </button>
            )}
          </div>

          {applyError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{applyError}</p>}
          {applyResult && (
            <div className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Updated {applyResult.succeeded} product{applyResult.succeeded === 1 ? "" : "s"} in Cin7.
              {applyResult.failed.length > 0 && (
                <>
                  <p className="mt-1 font-medium text-red-700">{applyResult.failed.length} failed:</p>
                  <ul className="mt-1 list-disc pl-5 text-red-700">
                    {applyResult.failed.map((f, i) => (
                      <li key={i}>
                        {f.productId}: {f.error}
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}

          {!valueIsValid && <p className="mt-4 text-sm text-slate-400">Enter a value above to see the proposed price changes.</p>}

          {valueIsValid && allCandidateLines.length === 0 && (
            <p className="mt-4 text-sm text-slate-400">Nothing would change — every filtered product already matches this value in {tierLabel}.</p>
          )}

          {valueIsValid && allCandidateLines.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4">
                      <input
                        type="checkbox"
                        checked={excludedProductIds.size === 0}
                        ref={(el) => {
                          if (el) el.indeterminate = excludedProductIds.size > 0 && excludedProductIds.size < allCandidateLines.length;
                        }}
                        onChange={toggleAllLines}
                        className="h-4 w-4"
                      />
                    </th>
                    <th className="py-2 pr-4">Product</th>
                    <th className="py-2 pr-4 text-right">Current</th>
                    <th className="py-2 pr-4 text-right">New</th>
                  </tr>
                </thead>
                <tbody>
                  {allCandidateLines.map((line: PriceUpdateLine) => {
                    const checked = !excludedProductIds.has(line.productId);
                    return (
                      <tr key={line.productId} className={`border-b border-slate-100 ${checked ? "" : "opacity-50"}`}>
                        <td className="py-1.5 pr-4">
                          <input type="checkbox" checked={checked} onChange={() => toggleLine(line.productId)} className="h-4 w-4" />
                        </td>
                        <td className="py-2 pr-4">
                          <div className="font-medium text-slate-900">{line.name}</div>
                          <div className="text-xs text-slate-400">{line.sku}</div>
                        </td>
                        <td className="py-2 pr-4 text-right text-slate-500">{money(line.currentValue)}</td>
                        <td className="py-2 pr-4 text-right font-medium">{money(line.newValue)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
