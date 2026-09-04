"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { getBillingStatusAction } from "@/actions/billing";
import { loadReorderConfigPreviewAction, applyReorderConfigAction, type ReorderConfigPreviewData } from "./actions";
import { filterReorderConfigProducts, buildReorderConfigLines, type ReorderConfigLine } from "@/reports/replenish/reorder-config";
import type { ApplyFixesResult } from "@/audit/apply-fixes";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Alert } from "@/components/ui/Alert";
import { Panel } from "@/components/ui/Panel";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";

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

      <Panel>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
          </div>
          <Button onClick={handleLoadProducts} disabled={!instanceId} loading={isLoadingPreview}>
            {isLoadingPreview ? "Loading…" : "Load products"}
          </Button>
        </div>
        {previewError && (
          <div className="mt-3">
            <Alert tone="danger">{previewError}</Alert>
          </div>
        )}
      </Panel>

      {previewData && (
        <Panel className="mt-6">
          <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-start sm:justify-between">
            {categories.length > 0 && (
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">Category</p>
                  <div className="flex gap-3 text-xs text-primary">
                    <button type="button" onClick={() => setCategoryFilter(categories)} className="hover:underline">
                      Select all
                    </button>
                    <button type="button" onClick={() => setCategoryFilter([])} className="hover:underline">
                      Clear
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
                  {categories.map((cat) => (
                    <Checkbox key={cat} label={cat} checked={categoryFilter.includes(cat)} onChange={() => toggleCategoryFilter(cat)} />
                  ))}
                </div>
              </div>
            )}

            {brands.length > 0 && (
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-700">Brand</p>
                  <div className="flex gap-3 text-xs text-primary">
                    <button type="button" onClick={() => setBrandFilter(brands)} className="hover:underline">
                      Select all
                    </button>
                    <button type="button" onClick={() => setBrandFilter([])} className="hover:underline">
                      Clear
                    </button>
                  </div>
                </div>
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto">
                  {brands.map((brand) => (
                    <Checkbox key={brand} label={brand} checked={brandFilter.includes(brand)} onChange={() => toggleBrandFilter(brand)} />
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1">
              <Input label="Search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Part of a SKU or product name…" />
              <p className="mt-2 text-xs text-slate-500">{filteredProducts.length} product(s) match.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-b border-slate-100 py-4">
            <Select label="Location" value={targetLocationId} onChange={(e) => setTargetLocationId(e.target.value)} className="w-48">
              <option value="">Choose a location…</option>
              {previewData.locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </Select>

            <Input
              label="Minimum before reorder"
              type="number"
              step="1"
              value={minimumBeforeReorder}
              onChange={(e) => setMinimumBeforeReorder(e.target.value)}
              placeholder="e.g. 10"
              className="w-32"
            />

            <Input
              label="Reorder quantity"
              type="number"
              step="1"
              value={reorderQuantity}
              onChange={(e) => setReorderQuantity(e.target.value)}
              placeholder="e.g. 30"
              className="w-32"
            />

            {selectedLines.length > 0 && (
              <Button
                onClick={handleApply}
                disabled={writeDisabled}
                title={!canWrite ? "Writing to Cin7 is disabled on your current plan." : undefined}
                loading={isApplying}
                className="ml-auto"
              >
                {isApplying ? "Updating…" : `Update ${selectedLines.length} product${selectedLines.length === 1 ? "" : "s"}`}
              </Button>
            )}
          </div>

          {applyError && (
            <div className="mt-3">
              <Alert tone="danger">{applyError}</Alert>
            </div>
          )}
          {applyResult && (
            <div className="mt-3">
              <Alert tone="success">
                Updated {applyResult.succeeded} product{applyResult.succeeded === 1 ? "" : "s"} in Cin7.
                {applyResult.failed.length > 0 && (
                  <>
                    <p className="mt-1 font-medium text-danger">{applyResult.failed.length} failed:</p>
                    <ul className="mt-1 list-disc pl-5">
                      {applyResult.failed.map((f, i) => (
                        <li key={i}>
                          {f.productId}: {f.error}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Alert>
            </div>
          )}

          {!valuesAreValid && (
            <p className="mt-4 text-sm text-slate-500">Choose a location and enter both values above to see the proposed changes.</p>
          )}

          {valuesAreValid && allCandidateLines.length === 0 && (
            <p className="mt-4 text-sm text-slate-500">Nothing would change — every filtered product already has these exact values for this location.</p>
          )}

          {valuesAreValid && allCandidateLines.length > 0 && (
            <div className="mt-4">
              <Table>
                <THead>
                  <tr>
                    <TH>
                      <input
                        type="checkbox"
                        aria-label="Select all products"
                        checked={excludedProductIds.size === 0}
                        ref={(el) => {
                          if (el) el.indeterminate = excludedProductIds.size > 0 && excludedProductIds.size < allCandidateLines.length;
                        }}
                        onChange={toggleAllLines}
                        className="h-4 w-4 rounded border-slate-300 text-primary"
                      />
                    </TH>
                    <TH>Product</TH>
                    <TH align="right">Current Min</TH>
                    <TH align="right">Current Qty</TH>
                    <TH align="right">New Min</TH>
                    <TH align="right">New Qty</TH>
                  </tr>
                </THead>
                <TBody>
                  {allCandidateLines.map((line: ReorderConfigLine) => {
                    const checked = !excludedProductIds.has(line.productId);
                    return (
                      <TR key={line.productId} className={checked ? "" : "opacity-50"}>
                        <TD>
                          <input
                            type="checkbox"
                            aria-label={`Select ${line.name}`}
                            checked={checked}
                            onChange={() => toggleLine(line.productId)}
                            className="h-4 w-4 rounded border-slate-300 text-primary"
                          />
                        </TD>
                        <TD>
                          <div className="font-medium text-slate-900">{line.name}</div>
                          <div className="font-mono text-xs text-slate-500">{line.sku}</div>
                        </TD>
                        <TD align="right" numeric className="text-slate-500">
                          {qty(line.currentMinimum)}
                        </TD>
                        <TD align="right" numeric className="text-slate-500">
                          {qty(line.currentReorderQuantity)}
                        </TD>
                        <TD align="right" numeric className="font-medium">
                          {qty(line.newMinimum)}
                        </TD>
                        <TD align="right" numeric className="font-medium">
                          {qty(line.newReorderQuantity)}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
