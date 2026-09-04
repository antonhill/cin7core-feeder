"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { getBillingStatusAction } from "@/actions/billing";
import {
  loadSupplierPlanAction,
  exportSupplierPlanXlsxAction,
  createSupplierPlanPurchaseOrdersAction,
  getPurchasePlannerSettingsAction,
  savePurchasePlannerSettingsAction,
  type CreatedPurchaseOrder,
  type FailedPurchaseOrder,
} from "./actions";
import { groupLinesBySupplier, type SupplierPlanLine, type SupplierPlanMoverCategory, type SupplierPlanStatus } from "@/reports/supplier-planner/build";
import type { Cin7Location } from "@/cin7/reference-lookups";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SUPPLIER_PLANNER_MODULE } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { Panel, PanelTitle } from "@/components/ui/Panel";

type Period = "1m" | "3m" | "6m" | "9m" | "12m";

const PERIOD_OPTIONS: { value: Period; label: string; months: number; days: number }[] = [
  { value: "1m", label: "Previous month", months: 1, days: 30 },
  { value: "3m", label: "Previous 3 months", months: 3, days: 90 },
  { value: "6m", label: "Previous 6 months", months: 6, days: 182 },
  { value: "9m", label: "Previous 9 months", months: 9, days: 274 },
  { value: "12m", label: "Previous 12 months", months: 12, days: 365 },
];

const BUFFER_OPTIONS = [0, 10, 20, 30];

const MOVER_OPTIONS: SupplierPlanMoverCategory[] = ["Fast", "Medium", "Slow", "No movement"];
const STATUS_OPTIONS: SupplierPlanStatus[] = ["Stockout risk", "Excess", "Healthy"];

const MOVER_TONE: Record<SupplierPlanMoverCategory, BadgeTone> = {
  Fast: "success",
  Medium: "warning",
  Slow: "danger",
  "No movement": "neutral",
};

const STATUS_TONE: Record<SupplierPlanStatus, BadgeTone> = {
  "Stockout risk": "danger",
  Excess: "warning",
  Healthy: "success",
};

function downloadBase64File(base64: string, filename: string, mimeType: string) {
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

/** "YYYY-MM-DD" for today minus N months, in local time. */
function monthsAgoIso(months: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d.toISOString().slice(0, 10);
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function qty(value: number): string {
  return value.toLocaleString();
}

function money(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  return `${currency ?? ""} ${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

function lineKey(line: SupplierPlanLine): string {
  return `${line.productSku}::${line.supplierId}::${line.locationId ?? "default"}`;
}

/** Cin7's own supplier Currency field — the closest signal this app has to "local vs foreign" supplier, since Cin7 has no such flag itself. */
function currencyLabel(line: SupplierPlanLine): string {
  return line.currency ?? "No currency";
}

const FILTER_PREVIEW_COUNT = 8;

/** A checkbox filter group that collapses to a short preview when the option list is long, with a "Show all (N)"/"Show less" toggle — keeps Category/Brand from blowing out the page's vertical space when a catalog has dozens of either. */
function CollapsibleCheckboxFilter({
  label,
  options,
  selected,
  onToggle,
  onClear,
}: {
  label: string;
  options: string[];
  selected: string[];
  onToggle: (value: string) => void;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasMore = options.length > FILTER_PREVIEW_COUNT;
  const visible = expanded ? options : options.slice(0, FILTER_PREVIEW_COUNT);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</span>
        <button type="button" onClick={onClear} className="text-xs text-primary hover:underline">
          Clear{selected.length > 0 ? ` (${selected.length})` : ""}
        </button>
      </div>
      <div className="flex max-w-2xl flex-wrap items-center gap-3">
        {visible.map((value) => (
          <Checkbox key={value} label={value} checked={selected.includes(value)} onChange={() => onToggle(value)} />
        ))}
      </div>
      {hasMore && (
        <button type="button" onClick={() => setExpanded((e) => !e)} className="self-start text-xs text-primary hover:underline">
          {expanded ? "Show less" : `Show all (${options.length})`}
        </button>
      )}
    </div>
  );
}

export default function SupplierPlannerPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [period, setPeriod] = useState<Period>("3m");
  const [bufferPercent, setBufferPercent] = useState(10);
  const [needsReorderOnly, setNeedsReorderOnly] = useState(true);

  const [lines, setLines] = useState<SupplierPlanLine[] | null>(null);
  const [locations, setLocations] = useState<Cin7Location[]>([]);
  const [receivingLocationId, setReceivingLocationId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [moverFilter, setMoverFilter] = useState<Set<SupplierPlanMoverCategory>>(new Set(MOVER_OPTIONS));
  const [statusFilter, setStatusFilter] = useState<Set<SupplierPlanStatus>>(new Set(STATUS_OPTIONS));
  // null = every currency shown (the implicit default) — distinct from an
  // explicit empty Set (every currency unchecked, nothing shown). Currency
  // options are data-driven (whatever Cin7 actually has), unlike Mover/
  // Status's fixed enums, so there's no static "all options" set to seed
  // from up front.
  const [currencyFilter, setCurrencyFilter] = useState<Set<string> | null>(null);
  // Empty array = no restriction — same convention as Reorder Points'
  // filterReorderConfigProducts (src/reports/replenish/reorder-config.ts).
  const [search, setSearch] = useState("");
  const [supplierFilter, setSupplierFilter] = useState<string[]>([]);
  const [brandFilter, setBrandFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  // Hidden by default — Cin7 returns an all-zero Lead/Safety/ReorderQuantity/
  // MinimumToReorder placeholder for a product+supplier link that's never
  // had Product Supplier Options configured at all (confirmed live
  // 2026-07-24), which otherwise shows up as a misleading "needs reorder,
  // suggested qty 0" line.
  const [showUnconfigured, setShowUnconfigured] = useState(false);

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const [canWrite, setCanWrite] = useState(true);
  useEffect(() => {
    getBillingStatusAction().then((res) => {
      if (res.ok && res.data) setCanWrite(res.data.canWrite);
    });
  }, []);

  // Per-run values for the import-supplier stock floor, pre-filled from the
  // org's saved default on mount but editable for a one-off what-if run
  // without changing that default. Empty homeCurrency string = the floor is
  // off (matches the org default being unconfigured/null).
  const [homeCurrency, setHomeCurrency] = useState("");
  const [importStockMonths, setImportStockMonths] = useState(4);
  const [isSavingDefaults, startSaveDefaultsTransition] = useTransition();
  const [saveDefaultsMessage, setSaveDefaultsMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    getPurchasePlannerSettingsAction().then((res) => {
      if (res.ok && res.data) {
        setHomeCurrency(res.data.homeCurrency ?? "");
        setImportStockMonths(res.data.importStockMonths);
      }
    });
  }, []);

  function handleSaveDefaults() {
    setSaveDefaultsMessage(null);
    startSaveDefaultsTransition(async () => {
      const result = await savePurchasePlannerSettingsAction({
        homeCurrency: homeCurrency.trim() ? homeCurrency.trim().toUpperCase() : null,
        importStockMonths,
      });
      setSaveDefaultsMessage(result.ok ? { ok: true, text: "Saved as this org's default." } : { ok: false, text: result.error ?? "Unknown error" });
    });
  }

  // Raw toggle state; ticking a line off excludes it from PO creation.
  // Filtered against currently-visible line keys below, same pattern as
  // Replenish's own excludedLineKeys — a leftover exclusion from before a
  // filter change can't silently apply to an unrelated line reusing the key.
  const [rawExcludedLineKeys, setRawExcludedLineKeys] = useState<Set<string>>(new Set());

  const [creatingSupplier, setCreatingSupplier] = useState<string | null>(null);
  const [isCreatingPo, startCreatePoTransition] = useTransition();
  const [poResults, setPoResults] = useState<
    Map<string, { created: CreatedPurchaseOrder[]; failed: FailedPurchaseOrder[]; deduplicated?: CreatedPurchaseOrder[]; error?: string }>
  >(new Map());

  function toggleMover(m: SupplierPlanMoverCategory) {
    setMoverFilter((prev) => {
      const next = new Set(prev);
      if (next.has(m)) next.delete(m);
      else next.add(m);
      return next;
    });
  }

  function toggleStatus(s: SupplierPlanStatus) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  const availableCurrencies = useMemo(() => [...new Set((lines ?? []).map(currencyLabel))].sort(), [lines]);

  function toggleCurrency(currency: string) {
    setCurrencyFilter((prev) => {
      const next = new Set(prev ?? availableCurrencies);
      if (next.has(currency)) next.delete(currency);
      else next.add(currency);
      return next;
    });
  }

  const availableSuppliers = useMemo(() => [...new Set((lines ?? []).map((l) => l.supplierName))].sort(), [lines]);
  const availableBrands = useMemo(() => [...new Set((lines ?? []).map((l) => l.brand).filter((b): b is string => b !== null))].sort(), [lines]);
  const availableCategories = useMemo(
    () => [...new Set((lines ?? []).map((l) => l.category).filter((c): c is string => c !== null))].sort(),
    [lines]
  );

  function toggleSupplier(supplier: string) {
    setSupplierFilter((prev) => (prev.includes(supplier) ? prev.filter((s) => s !== supplier) : [...prev, supplier]));
  }
  function toggleBrand(brand: string) {
    setBrandFilter((prev) => (prev.includes(brand) ? prev.filter((b) => b !== brand) : [...prev, brand]));
  }
  function toggleCategory(category: string) {
    setCategoryFilter((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
  }

  const visibleLines = useMemo(() => {
    if (!lines) return [];
    const needle = search.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (!needsReorderOnly || l.needsReorder) &&
        moverFilter.has(l.moverCategory) &&
        statusFilter.has(l.status) &&
        (currencyFilter === null || currencyFilter.has(currencyLabel(l))) &&
        (showUnconfigured || !l.isUnconfigured) &&
        (supplierFilter.length === 0 || supplierFilter.includes(l.supplierName)) &&
        (brandFilter.length === 0 || (l.brand !== null && brandFilter.includes(l.brand))) &&
        (categoryFilter.length === 0 || (l.category !== null && categoryFilter.includes(l.category))) &&
        (!needle ||
          l.productSku.toLowerCase().includes(needle) ||
          l.productName.toLowerCase().includes(needle) ||
          l.supplierName.toLowerCase().includes(needle))
    );
  }, [lines, needsReorderOnly, moverFilter, statusFilter, currencyFilter, showUnconfigured, supplierFilter, brandFilter, categoryFilter, search]);

  const unconfiguredCount = lines ? lines.filter((l) => l.isUnconfigured).length : 0;

  const grouped = useMemo(() => groupLinesBySupplier(visibleLines), [visibleLines]);

  const excludedLineKeys = useMemo(() => {
    const visibleKeys = new Set(visibleLines.map(lineKey));
    return new Set([...rawExcludedLineKeys].filter((k) => visibleKeys.has(k)));
  }, [rawExcludedLineKeys, visibleLines]);

  function toggleLine(key: string) {
    setRawExcludedLineKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleSupplierLines(supplierLines: SupplierPlanLine[]) {
    const keys = supplierLines.map(lineKey);
    const allSelected = keys.every((k) => !excludedLineKeys.has(k));
    setRawExcludedLineKeys((prev) => {
      const next = new Set(prev);
      keys.forEach((k) => (allSelected ? next.add(k) : next.delete(k)));
      return next;
    });
  }

  const receivingLocation = locations.find((l) => l.id === receivingLocationId);

  function handleCreatePo(supplierName: string, supplierLines: SupplierPlanLine[]) {
    if (!instanceId) return;
    const selected = supplierLines.filter((l) => !excludedLineKeys.has(lineKey(l)));
    if (!selected.length) return;
    setCreatingSupplier(supplierName);
    startCreatePoTransition(async () => {
      const result = await createSupplierPlanPurchaseOrdersAction(
        instanceId,
        selected,
        receivingLocation ? { locationId: receivingLocation.id, locationName: receivingLocation.name } : undefined
      );
      setPoResults((prev) => {
        const next = new Map(prev);
        if (result.data)
          next.set(supplierName, {
            created: result.data.created,
            failed: result.data.failed,
            deduplicated: result.data.deduplicated ?? [],
          });
        else next.set(supplierName, { created: [], failed: [], error: result.error ?? "Unknown error" });
        return next;
      });
      setCreatingSupplier(null);
    });
  }

  function handleRunPlan() {
    if (!instanceId) return;
    setError(null);
    setLines(null);
    setRawExcludedLineKeys(new Set());
    setPoResults(new Map());
    setReceivingLocationId("");
    setCurrencyFilter(null);
    setSearch("");
    setSupplierFilter([]);
    setBrandFilter([]);
    setCategoryFilter([]);
    const periodOption = PERIOD_OPTIONS.find((p) => p.value === period)!;
    startRunTransition(async () => {
      const result = await loadSupplierPlanAction({
        instanceId,
        velocityDateFrom: monthsAgoIso(periodOption.months),
        velocityDateTo: todayIso(),
        periodDays: periodOption.days,
        bufferPercent,
        homeCurrency: homeCurrency.trim() ? homeCurrency.trim().toUpperCase() : null,
        importStockMonths,
      });
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      const newLines = result.data?.lines ?? [];
      setLines(newLines);
      setLocations(result.data?.locations ?? []);
      // Default-deselect anything already covered by a draft PO awaiting
      // authorization in Cin7 — avoids accidentally creating a duplicate.
      // Still shown (with a badge) and still toggleable, in case the user
      // genuinely needs another PO on top of it.
      setRawExcludedLineKeys(new Set(newLines.filter((l) => l.pendingPurchaseOrder).map(lineKey)));
    });
  }

  const needsReorderCount = lines ? lines.filter((l) => l.needsReorder).length : 0;

  function handleExport() {
    if (!visibleLines.length) return;
    setExportError(null);
    startExportTransition(async () => {
      const result = await exportSupplierPlanXlsxAction(visibleLines);
      if (!result.ok || !result.data) {
        setExportError(result.error ?? "Unknown error");
        return;
      }
      downloadBase64File(result.data, "purchase-planner.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  return (
    <main className="mx-auto w-full max-w-[1800px] px-6 py-12">
      <ModuleHeader module={SUPPLIER_PLANNER_MODULE}>
        Combines each supplier&apos;s configured lead time and safety stock (Cin7&apos;s own Product Supplier Options)
        with recent sales velocity to flag which products need reordering before they run out during transit — the
        lead-time-aware workflow for imports/long-lead-time suppliers. For simple local suppliers with no meaningful
        lead time, use the Reorder Report instead.
      </ModuleHeader>

      <Panel className="mt-6">
        <PanelTitle>Filters</PanelTitle>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
          </div>

          <Select label="Sales period" value={period} onChange={(e) => setPeriod(e.target.value as Period)}>
            {PERIOD_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>

          <Select label="Buffer" value={bufferPercent} onChange={(e) => setBufferPercent(Number(e.target.value))}>
            {BUFFER_OPTIONS.map((b) => (
              <option key={b} value={b}>
                +{b}%
              </option>
            ))}
          </Select>
        </div>

        <div className="mt-5 border-t border-slate-100 pt-4">
          <p className="text-sm font-medium text-slate-700">Import supplier stock floor</p>
          <p className="mt-1 max-w-2xl text-xs text-slate-500">
            For any supplier whose Currency differs from the home currency below, the suggested quantity never drops below N
            months of average sales — on top of, not instead of, the usual lead-time calculation. Leave home currency blank to
            turn this off. This might not suit every client, so it&apos;s a setting, not a fixed rule.
          </p>
          <div className="mt-3 flex flex-wrap items-end gap-3">
            <Input
              label="Home currency"
              value={homeCurrency}
              onChange={(e) => setHomeCurrency(e.target.value)}
              placeholder="e.g. ZAR"
              className="w-28 uppercase"
              maxLength={3}
            />
            <Input
              label="Months of stock (import)"
              type="number"
              min={0}
              step={0.5}
              value={importStockMonths}
              onChange={(e) => setImportStockMonths(Number(e.target.value))}
              className="w-32"
            />
            <Button variant="secondary" size="sm" onClick={handleSaveDefaults} loading={isSavingDefaults}>
              {isSavingDefaults ? "Saving…" : "Save as org default"}
            </Button>
          </div>
          {saveDefaultsMessage && (
            <div className="mt-2">
              <Alert tone={saveDefaultsMessage.ok ? "success" : "danger"}>{saveDefaultsMessage.text}</Alert>
            </div>
          )}
        </div>

        <div className="mt-5">
          <Button onClick={handleRunPlan} disabled={!instanceId} loading={isRunning}>
            {isRunning ? "Running…" : "Run plan"}
          </Button>
        </div>

        {error && (
          <div className="mt-4">
            <Alert tone="danger">{error}</Alert>
          </div>
        )}
      </Panel>

      {lines && (
        <section className="mt-6 flex flex-col gap-6">
          <Panel className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-slate-500">
              {visibleLines.length} line{visibleLines.length === 1 ? "" : "s"} across {grouped.size} supplier{grouped.size === 1 ? "" : "s"} —{" "}
              {needsReorderCount} need reordering at this buffer
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                label="Search product, SKU, or supplier"
                hideLabel
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search product, SKU, or supplier…"
                className="h-8 w-64"
              />
              <Checkbox label="Needs reorder only" checked={needsReorderOnly} onChange={(e) => setNeedsReorderOnly(e.target.checked)} />
              <Button variant="secondary" size="sm" onClick={handleExport} disabled={visibleLines.length === 0} loading={isExporting}>
                {isExporting ? "Exporting…" : "Export to Excel"}
              </Button>
            </div>
          </Panel>

          <Panel className="flex flex-wrap items-center gap-3">
            <Select
              label="Receiving location"
              value={receivingLocationId}
              onChange={(e) => setReceivingLocationId(e.target.value)}
              className="w-56"
            >
              <option value="">Choose a location…</option>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))}
            </Select>
            <p className="max-w-md text-xs text-slate-500">
              Used for lines with no location of their own (most lines) when creating a PO — Cin7 needs exactly one receiving location per
              order. A line that already has its own specific location keeps that instead.
            </p>
          </Panel>

          <Panel className="flex flex-wrap gap-x-6 gap-y-2">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Mover</span>
              {MOVER_OPTIONS.map((m) => (
                <Checkbox key={m} label={m} checked={moverFilter.has(m)} onChange={() => toggleMover(m)} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Status</span>
              {STATUS_OPTIONS.map((s) => (
                <Checkbox key={s} label={s} checked={statusFilter.has(s)} onChange={() => toggleStatus(s)} />
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-xs font-medium uppercase tracking-wide text-slate-500">Currency</span>
              {availableCurrencies.map((c) => (
                <Checkbox key={c} label={c} checked={currencyFilter === null || currencyFilter.has(c)} onChange={() => toggleCurrency(c)} />
              ))}
            </div>
            <Checkbox
              label={`Show unconfigured entries${!showUnconfigured && unconfiguredCount > 0 ? ` (${unconfiguredCount} hidden)` : ""}`}
              checked={showUnconfigured}
              onChange={(e) => setShowUnconfigured(e.target.checked)}
            />
          </Panel>

          {(availableSuppliers.length > 0 || availableBrands.length > 0 || availableCategories.length > 0) && (
            <Panel className="flex flex-wrap gap-x-6 gap-y-3">
              {availableSuppliers.length > 0 && (
                <CollapsibleCheckboxFilter
                  label="Supplier"
                  options={availableSuppliers}
                  selected={supplierFilter}
                  onToggle={toggleSupplier}
                  onClear={() => setSupplierFilter([])}
                />
              )}
              {availableBrands.length > 0 && (
                <CollapsibleCheckboxFilter
                  label="Brand"
                  options={availableBrands}
                  selected={brandFilter}
                  onToggle={toggleBrand}
                  onClear={() => setBrandFilter([])}
                />
              )}
              {availableCategories.length > 0 && (
                <CollapsibleCheckboxFilter
                  label="Category"
                  options={availableCategories}
                  selected={categoryFilter}
                  onToggle={toggleCategory}
                  onClear={() => setCategoryFilter([])}
                />
              )}
            </Panel>
          )}

          {exportError && <Alert tone="danger">{exportError}</Alert>}

          {visibleLines.length === 0 && (
            <EmptyState
              title="No matching products"
              description="No products with a configured lead time match these filters."
            />
          )}

          {[...grouped.entries()].map(([supplierName, supplierLines]) => {
            const selectedLines = supplierLines.filter((l) => !excludedLineKeys.has(lineKey(l)));
            const selectedCount = selectedLines.length;
            const allSelected = selectedCount === supplierLines.length;
            const poResult = poResults.get(supplierName);
            const isCreatingThisSupplier = isCreatingPo && creatingSupplier === supplierName;
            const hasResolvableLocation = selectedLines.some((l) => l.locationId || receivingLocation);
            const createDisabled = isCreatingPo || !canWrite || selectedCount === 0 || !hasResolvableLocation;
            const createTitle = !canWrite
              ? "Writing to Cin7 is disabled on your current plan."
              : selectedCount > 0 && !hasResolvableLocation
                ? "Choose a receiving location above — none of the selected lines have one of their own."
                : undefined;
            return (
              <Panel key={supplierName}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-base font-semibold text-slate-900">
                    {supplierName}{" "}
                    <span className="ml-2 text-sm font-normal text-slate-500">
                      {supplierLines.length} line{supplierLines.length === 1 ? "" : "s"}
                    </span>
                  </p>
                  <Button
                    size="sm"
                    onClick={() => handleCreatePo(supplierName, supplierLines)}
                    disabled={createDisabled}
                    title={createTitle}
                    loading={isCreatingThisSupplier}
                  >
                    {isCreatingThisSupplier ? "Creating…" : `Create PO${selectedCount > 0 ? ` (${selectedCount} line${selectedCount === 1 ? "" : "s"})` : ""}`}
                  </Button>
                </div>

                {poResult?.error && (
                  <div className="mt-3">
                    <Alert tone="danger">{poResult.error}</Alert>
                  </div>
                )}
                {poResult && (poResult.created.length > 0 || poResult.failed.length > 0 || (poResult.deduplicated?.length ?? 0) > 0) && (
                  <div className="mt-3 flex flex-col gap-2">
                    {(poResult.deduplicated?.length ?? 0) > 0 && (
                      <Alert tone="warning">
                        {poResult.deduplicated!.length} PO{poResult.deduplicated!.length === 1 ? " was" : "s were"} already created moments ago for the same lines — returned the existing
                        {poResult.deduplicated!.length === 1 ? " one" : " ones"} instead of a duplicate:
                        <ul className="mt-1 list-disc pl-5">
                          {poResult.deduplicated!.map((po) => (
                            <li key={`dedup-${po.orderNumber}-${po.locationName}`}>
                              <strong>{po.orderNumber}</strong> → {po.locationName}
                            </li>
                          ))}
                        </ul>
                      </Alert>
                    )}
                    {poResult.created.length > 0 && (
                      <Alert tone="success">
                        Created {poResult.created.length} draft PO{poResult.created.length === 1 ? "" : "s"} in Cin7 — review and authorize
                        {poResult.created.length === 1 ? " it" : " them"} there:
                        <ul className="mt-1 list-disc pl-5">
                          {poResult.created.map((po) => (
                            <li key={`${po.orderNumber}-${po.locationName}`}>
                              <strong>{po.orderNumber}</strong> → {po.locationName} ({po.lineCount} line{po.lineCount === 1 ? "" : "s"}, {po.status})
                            </li>
                          ))}
                        </ul>
                      </Alert>
                    )}
                    {poResult.failed.length > 0 && (
                      <Alert tone="danger">
                        {poResult.failed.length} PO{poResult.failed.length === 1 ? "" : "s"} failed to create:
                        <ul className="mt-1 list-disc pl-5">
                          {poResult.failed.map((f) => (
                            <li key={`${f.supplierName}-${f.locationName}`}>
                              {f.locationName}: {f.error}
                            </li>
                          ))}
                        </ul>
                      </Alert>
                    )}
                  </div>
                )}

                <div className="mt-3">
                  <Table>
                    <THead>
                      <tr>
                        <TH>
                          <input
                            type="checkbox"
                            aria-label={`Select all lines for ${supplierName}`}
                            checked={allSelected}
                            ref={(el) => {
                              if (el) el.indeterminate = selectedCount > 0 && selectedCount < supplierLines.length;
                            }}
                            onChange={() => toggleSupplierLines(supplierLines)}
                            className="h-4 w-4 rounded border-slate-300 text-primary"
                          />
                        </TH>
                        <TH>Product</TH>
                        <TH>Location</TH>
                        <TH align="right">Lead + Safety</TH>
                        <TH align="right">On Hand</TH>
                        <TH align="right">On Order</TH>
                        <TH align="right">Reorder At</TH>
                        <TH align="right">Suggested Qty</TH>
                        <TH align="right">Latest Price</TH>
                        <TH>Mover</TH>
                        <TH>Status</TH>
                      </tr>
                    </THead>
                    <TBody>
                      {supplierLines.map((line) => {
                        const key = lineKey(line);
                        const checked = !excludedLineKeys.has(key);
                        return (
                          <TR
                            key={key}
                            flagged={line.needsReorder ? "warning" : undefined}
                            className={`${line.needsReorder ? "bg-warning-subtle" : ""} ${checked ? "" : "opacity-50"}`}
                          >
                            <TD>
                              <input
                                type="checkbox"
                                aria-label={`Select ${line.productName}`}
                                checked={checked}
                                onChange={() => toggleLine(key)}
                                className="h-4 w-4 rounded border-slate-300 text-primary"
                              />
                            </TD>
                            <TD>
                              <div className="font-medium text-slate-900">{line.productName}</div>
                              <div className="font-mono text-xs text-slate-500">{line.productSku}</div>
                              {line.pendingPurchaseOrder && (
                                <span
                                  title={`Created ${new Date(line.pendingPurchaseOrder.createdAt).toLocaleString()} — not yet authorized in Cin7. Deselected by default to avoid a duplicate.`}
                                  className="mt-1 inline-block"
                                >
                                  <Badge tone="warning">{line.pendingPurchaseOrder.orderNumber} pending authorization</Badge>
                                </span>
                              )}
                            </TD>
                            <TD className="text-slate-500">{line.locationName ?? "All locations"}</TD>
                            <TD align="right" numeric>
                              {line.lead}+{line.safety}
                            </TD>
                            <TD align="right" numeric>{qty(line.onHand)}</TD>
                            <TD align="right" numeric>{qty(line.onOrder)}</TD>
                            <TD align="right" numeric>{qty(line.threshold)}</TD>
                            <TD align="right" numeric className="font-medium">{qty(line.suggestedQty)}</TD>
                            <TD align="right" numeric>
                              {money(line.cost, line.currency)}
                              {line.isImportSupplier && (
                                <span
                                  title="Supplier's currency differs from this org's home currency — the import stock-floor was considered for this line."
                                  className="ml-1.5 inline-block"
                                >
                                  <Badge tone="info">Import</Badge>
                                </span>
                              )}
                            </TD>
                            <TD>
                              <Badge tone={MOVER_TONE[line.moverCategory]}>{line.moverCategory}</Badge>
                            </TD>
                            <TD>
                              <Badge tone={STATUS_TONE[line.status]}>{line.status}</Badge>
                            </TD>
                          </TR>
                        );
                      })}
                    </TBody>
                  </Table>
                </div>
              </Panel>
            );
          })}
        </section>
      )}
    </main>
  );
}
