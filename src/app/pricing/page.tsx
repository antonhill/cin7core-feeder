"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { getBillingStatusAction } from "@/actions/billing";
import { loadPricingPreviewAction, applyPriceUpdatesAction } from "./actions";
import type { PricingFetchResult } from "@/cin7/pricing";
import { filterPriceableProducts, buildPriceUpdateLines, type PriceUpdateMode, type PriceUpdateLine } from "@/pricing/build";
import type { ApplyFixesResult } from "@/audit/apply-fixes";
import { ModuleHeader } from "@/app/ModuleHeader";
import { PRICING_MODULE } from "@/app/module-nav";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Alert } from "@/components/ui/Alert";
import { Panel, PanelTitle } from "@/components/ui/Panel";

function money(value: number): string {
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PricingPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

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
    // Native confirm() left as-is deliberately — this is a confirmation-
    // semantics change, out of scope for the reskin.
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
    <main className="mx-auto w-full max-w-[1800px] px-6 py-12">
      <ModuleHeader module={PRICING_MODULE}>
        Filters one connected instance&rsquo;s live product catalog by Category, Supplier, and search, then bulk-updates
        one chosen price tier — set a single flat price across every selected product, or increase each product&rsquo;s
        own current price by a percentage. Writes directly to Cin7.
      </ModuleHeader>
      <PageLoadingIndicator show={isLoadingPreview} label="Loading products…" />

      <Panel className="mt-6">
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
                  <PanelTitle>Category</PanelTitle>
                  <div className="flex gap-3 text-xs">
                    <Button variant="link" onClick={() => setCategoryFilter(categories)}>
                      Select all
                    </Button>
                    <Button variant="link" onClick={() => setCategoryFilter([])}>
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                  {categories.map((cat) => (
                    <Checkbox key={cat} label={cat} checked={categoryFilter.includes(cat)} onChange={() => toggleCategoryFilter(cat)} />
                  ))}
                </div>
              </div>
            )}

            {suppliers.length > 0 && (
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <PanelTitle>Supplier</PanelTitle>
                  <div className="flex gap-3 text-xs">
                    <Button variant="link" onClick={() => setSupplierFilter(suppliers)}>
                      Select all
                    </Button>
                    <Button variant="link" onClick={() => setSupplierFilter([])}>
                      Clear
                    </Button>
                  </div>
                </div>
                <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                  {suppliers.map((sup) => (
                    <Checkbox key={sup} label={sup} checked={supplierFilter.includes(sup)} onChange={() => toggleSupplierFilter(sup)} />
                  ))}
                </div>
              </div>
            )}

            <div className="flex-1">
              <Input
                label="Search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Part of a SKU or product name…"
                helperText={`${filteredProducts.length} product(s) match.`}
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-4 border-b border-slate-100 py-4">
            <Select label="Price tier" value={tierIndex} onChange={(e) => setTierIndex(Number(e.target.value))} className="w-44">
              {previewData.tierLabels.map((label, i) => (
                <option key={label} value={i}>
                  {label}
                </option>
              ))}
            </Select>

            <div>
              <p className="text-sm font-medium text-slate-700">Mode</p>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  onClick={() => setMode("set")}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === "set" ? "border-primary-border bg-primary-subtle text-primary" : "border-slate-300 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Set exact price
                </button>
                <button
                  type="button"
                  onClick={() => setMode("increase_percent")}
                  className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
                    mode === "increase_percent"
                      ? "border-primary-border bg-primary-subtle text-primary"
                      : "border-slate-300 text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  Increase by %
                </button>
              </div>
            </div>

            <Input
              label={mode === "set" ? "New price" : "% increase"}
              type="number"
              step="0.01"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={mode === "set" ? "e.g. 99.99" : "e.g. 10"}
              className="w-32"
            />

            {selectedLines.length > 0 && (
              <Button
                onClick={handleApply}
                disabled={writeDisabled}
                loading={isApplying}
                title={!canWrite ? "Writing to Cin7 is disabled on your current plan." : undefined}
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
                    <ul className="mt-1 list-disc pl-5 text-danger">
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

          {!valueIsValid && <p className="mt-4 text-sm text-slate-500">Enter a value above to see the proposed price changes.</p>}

          {valueIsValid && allCandidateLines.length === 0 && (
            <p className="mt-4 text-sm text-slate-500">Nothing would change — every filtered product already matches this value in {tierLabel}.</p>
          )}

          {valueIsValid && allCandidateLines.length > 0 && (
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
                    <TH align="right">Current</TH>
                    <TH align="right">New</TH>
                  </tr>
                </THead>
                <TBody>
                  {allCandidateLines.map((line: PriceUpdateLine) => {
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
                          {money(line.currentValue)}
                        </TD>
                        <TD align="right" numeric className="font-medium">
                          {money(line.newValue)}
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
    </main>
  );
}
