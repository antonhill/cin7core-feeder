"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { getBillingStatusAction } from "@/actions/billing";
import { loadReorderConfigPreviewAction, applyReorderConfigAction, type ReorderConfigPreviewData } from "./actions";
import { filterReorderConfigProducts, buildReorderConfigLines, type ReorderConfigLine } from "@/reports/replenish/reorder-config";
import type { ApplyFixesResult } from "@/audit/apply-fixes";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";

function qty(value: number | null): string {
  return value === null ? "—" : value.toLocaleString();
}

export default function ReorderPointsPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [previewData, setPreviewData] = useState<ReorderConfigPreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, startPreviewTransition] = useTransition();

  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [brandFilter, setBrandFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  const [targetLocationId, setTargetLocationId] = useState("");
  const [minimumBeforeReorder, setMinimumBeforeReorder] = useState("");
  const [reorderQuantity, setReorderQuantity] = useState("");

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

  const brands = useMemo(() => {
    if (!previewData) return [];
    return [...new Set(previewData.products.map((p) => p.brand).filter((b): b is string => b !== null))].sort();
  }, [previewData]);

  const filteredProducts = useMemo(() => {
    if (!previewData) return [];
    return filterReorderConfigProducts(previewData.products, categoryFilter, brandFilter, search);
  }, [previewData, categoryFilter, brandFilter, search]);

  const targetLocation = previewData?.locations.find((l) => l.id === targetLocationId) ?? null;
  const parsedMin = minimumBeforeReorder.trim() === "" ? null : Number(minimumBeforeReorder);
  const parsedQty = reorderQuantity.trim() === "" ? null : Number(reorderQuantity);
  const valuesAreValid = targetLocation !== null && parsedMin !== null && !Number.isNaN(parsedMin) && parsedQty !== null && !Number.isNaN(parsedQty);

  // Recomputed instantly whenever the filters/target location/values change
  // — no server round trip, since buildReorderConfigLines is a pure
  // function and the preview action already handed over every raw
  // ingredient it needs. Every filtered product is a starting candidate;
  // per-line exclusion (below) narrows which actually get pushed.
  const allCandidateLines = useMemo(() => {
    if (!valuesAreValid || !targetLocation) return [];
    const allIds = new Set(filteredProducts.map((p) => p.productId));
    return buildReorderConfigLines(filteredProducts, allIds, targetLocation.id, targetLocation.name, parsedMin as number, parsedQty as number);
  }, [filteredProducts, targetLocation, parsedMin, parsedQty, valuesAreValid]);

  // Same "drop stale exclusions against the currently visible set" pattern
  // as Replenish/Bulk Pricing's own line-selection checkboxes.
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

  function toggleBrandFilter(brand: string) {
    setBrandFilter((prev) => (prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]));
  }

  function handleLoadProducts() {
    if (!instanceId) return;
    setPreviewError(null);
    setApplyResult(null);
    setApplyError(null);
    setRawExcludedProductIds(new Set());
    setCategoryFilter([]);
    setBrandFilter([]);
    setSearch("");
    setTargetLocationId("");
    setMinimumBeforeReorder("");
    setReorderQuantity("");
    startPreviewTransition(async () => {
      const result = await loadReorderConfigPreviewAction(instanceId);
      if (!result.ok) {
        setPreviewError(result.error ?? "Unknown error");
        return;
      }
      setPreviewData(result.data ?? null);
    });
  }

  function handleApply() {
    if (!instanceId || selectedLines.length === 0 || !targetLocation) return;
    if (!confirm(`Update the reorder point for "${targetLocation.name}" on ${selectedLines.length} product(s)? This writes directly to Cin7.`)) return;
    setApplyError(null);
    setApplyResult(null);
    startApplyTransition(async () => {
      const result = await applyReorderConfigAction(instanceId, selectedLines);
      if (!result.ok) {
        setApplyError(result.error ?? "Unknown error");
        return;
      }
      setApplyResult(result.data ?? null);
    });
  }

  const writeDisabled = isApplying || !canWrite;

  return (
    <>
      <PageLoadingIndicator show={isLoadingPreview} label="Loading products…" />

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
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

            {brands.length > 0 && (
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">Brand</p>
                  <div className="flex gap-3 text-xs text-indigo-600">
                    <button type="button" onClick={() => setBrandFilter(brands)} className="hover:underline">
                      Select all
                    </button>
                    <button type="button" onClick={() => setBrandFilter([])} className="hover:underline">
                      Clear
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                  {brands.map((brand) => (
                    <label key={brand} className="flex items-center gap-2">
                      <input type="checkbox" checked={brandFilter.includes(brand)} onChange={() => toggleBrandFilter(brand)} className="h-4 w-4" />
                      {brand}
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
              <p className="text-sm font-medium text-slate-700">Location</p>
              <select
                value={targetLocationId}
                onChange={(e) => setTargetLocationId(e.target.value)}
                className="mt-2 rounded-lg border border-slate-300 px-3 py-2 text-sm"
              >
                <option value="">Choose a location…</option>
                {previewData.locations.map((loc) => (
                  <option key={loc.id} value={loc.id}>
                    {loc.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <p className="text-sm font-medium text-slate-700">Minimum before reorder</p>
              <input
                type="number"
                step="1"
                value={minimumBeforeReorder}
                onChange={(e) => setMinimumBeforeReorder(e.target.value)}
                placeholder="e.g. 10"
                className="mt-2 w-32 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
              />
            </div>

            <div>
              <p className="text-sm font-medium text-slate-700">Reorder quantity</p>
              <input
                type="number"
                step="1"
                value={reorderQuantity}
                onChange={(e) => setReorderQuantity(e.target.value)}
                placeholder="e.g. 30"
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

          {!valuesAreValid && (
            <p className="mt-4 text-sm text-slate-400">Choose a location and enter both values above to see the proposed changes.</p>
          )}

          {valuesAreValid && allCandidateLines.length === 0 && (
            <p className="mt-4 text-sm text-slate-400">Nothing would change — every filtered product already has these exact values for this location.</p>
          )}

          {valuesAreValid && allCandidateLines.length > 0 && (
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
                    <th className="py-2 pr-4 text-right">Current Min</th>
                    <th className="py-2 pr-4 text-right">Current Qty</th>
                    <th className="py-2 pr-4 text-right">New Min</th>
                    <th className="py-2 pr-4 text-right">New Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {allCandidateLines.map((line: ReorderConfigLine) => {
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
                        <td className="py-2 pr-4 text-right text-slate-500">{qty(line.currentMinimum)}</td>
                        <td className="py-2 pr-4 text-right text-slate-500">{qty(line.currentReorderQuantity)}</td>
                        <td className="py-2 pr-4 text-right font-medium">{qty(line.newMinimum)}</td>
                        <td className="py-2 pr-4 text-right font-medium">{qty(line.newReorderQuantity)}</td>
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
