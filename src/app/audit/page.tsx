"use client";

import { useMemo, useState, useTransition } from "react";
import {
  runProductAuditAction,
  applyProductFixesAction,
  mergeCategoryAction,
  mergeBrandAction,
  mergeUOMAction,
  mergeTagAction,
  applyAttributeTemplateAction,
} from "./actions";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import type {
  AttributeGapGroup,
  DuplicateNameGroup,
  ProductAuditIssue,
  ProductAuditIssueType,
  ProductAuditResult,
  ProductSummary,
} from "@/audit/product-audit";
import type { ApplyFixesResult } from "@/audit/apply-fixes";
import { ModuleHeader } from "@/app/ModuleHeader";
import { AUDIT_MODULE } from "@/app/module-nav";

const FIXABLE_CONFIG: Partial<Record<ProductAuditIssueType, { label: string; field: string; placeholder: string }>> = {
  missing_brand: { label: "Missing Brand", field: "Brand", placeholder: "e.g. Acme" },
  missing_location: { label: "Missing Default Location", field: "DefaultLocation", placeholder: "e.g. Main Warehouse" },
  missing_uom: { label: "Missing Unit of Measure", field: "UOM", placeholder: "e.g. Item" },
  missing_inventory_account: { label: "Missing Inventory Account", field: "InventoryAccount", placeholder: "e.g. 630" },
  missing_revenue_account: { label: "Missing Revenue Account", field: "RevenueAccount", placeholder: "e.g. 200" },
  missing_cogs_account: { label: "Missing COGS Account", field: "COGSAccount", placeholder: "e.g. 310" },
};

const ISSUE_ORDER: ProductAuditIssueType[] = [
  "missing_brand",
  "missing_sales_pricing",
  "missing_location",
  "missing_uom",
  "missing_inventory_account",
  "missing_revenue_account",
  "missing_cogs_account",
];

function matchesSearch(search: string, sku: string, name: string): boolean {
  if (!search.trim()) return true;
  const needle = search.trim().toLowerCase();
  return sku.toLowerCase().includes(needle) || name.toLowerCase().includes(needle);
}

function IssueTypeSection({
  type,
  issues,
  onApply,
  isApplying,
}: {
  type: ProductAuditIssueType;
  issues: ProductAuditIssue[];
  onApply: (productIds: string[], field: string, value: string) => void;
  isApplying: boolean;
}) {
  const [rawSelected, setRawSelected] = useState<Set<string>>(new Set());
  const [value, setValue] = useState("");
  const config = FIXABLE_CONFIG[type];

  // Derived, not synced via effect: drop any selected id that's fallen out of
  // view (category/search narrowed) so a stale selection from a previous
  // filter can't get silently fixed once it's no longer shown. This card is
  // no longer remounted per filter change (that was the real perf cost —
  // toggling a category checkbox used to unmount/remount every issue card),
  // so `rawSelected` can otherwise outlive filter changes.
  const selected = useMemo(() => {
    const visibleIds = new Set(issues.map((i) => i.productId));
    return new Set([...rawSelected].filter((id) => visibleIds.has(id)));
  }, [rawSelected, issues]);

  function toggle(id: string) {
    setRawSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setRawSelected(selected.size === issues.length && issues.length > 0 ? new Set() : new Set(issues.map((i) => i.productId)));
  }

  return (
    <details className="rounded-xl border border-amber-200 bg-amber-50 p-4" open={issues.length <= 5}>
      <summary className="cursor-pointer font-medium text-amber-900">
        {config?.label ?? "Missing Sales Pricing"} — {issues.length} product{issues.length === 1 ? "" : "s"}
      </summary>

      {type === "missing_sales_pricing" && (
        <p className="mt-2 text-sm text-amber-800">
          No bulk fix here — a sell price is specific to each product, so there&rsquo;s no single value that
          makes sense to apply across all of them. Fix these individually in Cin7 or via a normal price-tier
          import.
        </p>
      )}

      <div className="mt-3 flex flex-col gap-1.5 text-sm">
        <label className="flex items-center gap-2 font-medium text-amber-900">
          <input type="checkbox" checked={selected.size === issues.length && issues.length > 0} onChange={toggleAll} className="h-4 w-4" />
          Select all
        </label>
        {issues.map((issue) => (
          <label key={issue.productId} className="flex items-center gap-2 text-amber-800">
            <input type="checkbox" checked={selected.has(issue.productId)} onChange={() => toggle(issue.productId)} className="h-4 w-4" />
            {issue.name} <span className="text-xs text-amber-600">({issue.sku})</span>
          </label>
        ))}
      </div>

      {config && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={config.placeholder}
            className="w-56 rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
          />
          <button
            type="button"
            disabled={isApplying || selected.size === 0 || !value.trim()}
            onClick={() => {
              if (!confirm(`Set ${config.label} to "${value.trim()}" on ${selected.size} product(s)? This writes directly to Cin7.`)) return;
              onApply([...selected], config.field, value.trim());
            }}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Apply to {selected.size || ""} selected
          </button>
        </div>
      )}
    </details>
  );
}

function DuplicateGroupCard({
  group,
  onMerge,
  isApplying,
}: {
  group: DuplicateNameGroup;
  onMerge: (fromNames: string[], toName: string) => void;
  isApplying: boolean;
}) {
  const [keep, setKeep] = useState(group.names[0].name);

  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3 text-sm">
      <ul className="flex flex-col gap-1.5">
        {group.names.map((n) => (
          <li key={n.name} className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-slate-800">
              <input type="radio" name={`keep-${group.names[0].name}`} checked={keep === n.name} onChange={() => setKeep(n.name)} className="h-4 w-4" />
              &ldquo;{n.name}&rdquo;
            </label>
            <span className="text-slate-400">
              {n.productCount} product{n.productCount === 1 ? "" : "s"}
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        disabled={isApplying}
        onClick={() => {
          const fromNames = group.names.map((n) => n.name).filter((name) => name !== keep);
          if (!confirm(`Merge ${fromNames.length} other value(s) into "${keep}"? This writes directly to Cin7.`)) return;
          onMerge(fromNames, keep);
        }}
        className="mt-2 rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        Merge the rest into &ldquo;{keep}&rdquo;
      </button>
    </div>
  );
}

function AttributeGapCard({
  group,
  onApply,
  isApplying,
}: {
  group: AttributeGapGroup;
  onApply: (templateProductId: string, targetProductIds: string[]) => void;
  isApplying: boolean;
}) {
  const [templateId, setTemplateId] = useState(group.templates[0]?.productId ?? "");
  const [rawSelected, setRawSelected] = useState<Set<string>>(new Set(group.products.map((p) => p.productId)));

  // Derived, not synced via effect — same reasoning as IssueTypeSection:
  // this card is no longer remounted per search keystroke, so drop any
  // selected id that's fallen out of view instead of syncing state in an
  // effect (which would just cause an extra cascading render for the same
  // result).
  const selected = useMemo(() => {
    const visibleIds = new Set(group.products.map((p) => p.productId));
    return new Set([...rawSelected].filter((id) => visibleIds.has(id)));
  }, [rawSelected, group.products]);

  function toggle(id: string) {
    setRawSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="rounded-lg border border-amber-200 bg-white p-3 text-sm">
      <p className="font-medium text-amber-900">
        {group.category} — slot{group.slots.length === 1 ? "" : "s"} {group.slots.join(", ")} look under-filled
      </p>
      <ul className="mt-2 flex flex-col gap-1.5">
        {group.products.map((p) => (
          <li key={p.productId} className="flex items-center gap-2 text-slate-800">
            <input type="checkbox" checked={selected.has(p.productId)} onChange={() => toggle(p.productId)} className="h-4 w-4" />
            {p.name}{" "}
            <span className="text-xs text-slate-400">
              ({p.sku}) — missing slot{p.missingSlots.length === 1 ? "" : "s"} {p.missingSlots.join(", ")}
            </span>
          </li>
        ))}
      </ul>

      {group.templates.length > 0 ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-slate-700">
            Copy from
            <select
              value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              className="rounded-lg border border-slate-300 px-2 py-1 text-sm"
            >
              {group.templates.map((t) => (
                <option key={t.productId} value={t.productId}>
                  {t.name} ({t.sku})
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={isApplying || !templateId || selected.size === 0}
            onClick={() => {
              if (!confirm(`Copy attribute values to ${selected.size} product(s)? This writes directly to Cin7.`)) return;
              onApply(templateId, [...selected]);
            }}
            className="rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Copy to {selected.size} selected
          </button>
        </div>
      ) : (
        <p className="mt-2 text-xs text-amber-700">No fully-filled example product in this category to copy from.</p>
      )}
    </div>
  );
}

function SellableSection({
  products,
  onApply,
  isApplying,
}: {
  products: ProductSummary[];
  onApply: (productIds: string[], sellable: boolean) => void;
  isApplying: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === products.length ? new Set() : new Set(products.map((p) => p.productId))));
  }

  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer font-medium text-slate-900">
        Sellable — bulk set Yes/No ({products.length} product{products.length === 1 ? "" : "s"} shown)
      </summary>

      <div className="mt-3 flex flex-col gap-1.5 text-sm">
        <label className="flex items-center gap-2 font-medium text-slate-700">
          <input type="checkbox" checked={selected.size === products.length && products.length > 0} onChange={toggleAll} className="h-4 w-4" />
          Select all
        </label>
        <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {products.map((p) => (
            <label key={p.productId} className="flex items-center gap-2 text-slate-700">
              <input type="checkbox" checked={selected.has(p.productId)} onChange={() => toggle(p.productId)} className="h-4 w-4" />
              {p.name} <span className="text-xs text-slate-400">({p.sku})</span>
              <span className={`text-xs font-medium ${p.sellable ? "text-emerald-600" : "text-slate-400"}`}>
                {p.sellable ? "Sellable" : "Not sellable"}
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          disabled={isApplying || selected.size === 0}
          onClick={() => {
            if (!confirm(`Set Sellable to Yes on ${selected.size} product(s)? This writes directly to Cin7.`)) return;
            onApply([...selected], true);
          }}
          className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          Set Sellable: Yes ({selected.size || 0})
        </button>
        <button
          type="button"
          disabled={isApplying || selected.size === 0}
          onClick={() => {
            if (!confirm(`Set Sellable to No on ${selected.size} product(s)? This writes directly to Cin7.`)) return;
            onApply([...selected], false);
          }}
          className="rounded-full bg-slate-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-slate-500 disabled:opacity-50"
        >
          Set Sellable: No ({selected.size || 0})
        </button>
      </div>
    </details>
  );
}

export default function AuditPage() {
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [instanceId, setInstanceId] = useState<string | null>(null);

  const [result, setResult] = useState<ProductAuditResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isScanning, startScanTransition] = useTransition();

  const [isApplying, startApplyTransition] = useTransition();
  const [applyResult, setApplyResult] = useState<ApplyFixesResult | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);

  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [search, setSearch] = useState("");

  function toggleCategoryFilter(category: string) {
    setCategoryFilter((prev) => (prev.includes(category) ? prev.filter((c) => c !== category) : [...prev, category]));
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
    });
  }

  function handleScan() {
    if (!instanceId) return;
    setScanError(null);
    setResult(null);
    setApplyResult(null);
    startScanTransition(async () => {
      const res = await runProductAuditAction(instanceId);
      if (!res.ok) {
        setScanError(res.error ?? "Unknown error");
        return;
      }
      setResult(res.data ?? null);
    });
  }

  function handleApply(productIds: string[], field: string, value: string) {
    if (!instanceId) return;
    setApplyError(null);
    startApplyTransition(async () => {
      const res = await applyProductFixesAction(
        instanceId,
        productIds.map((productId) => ({ productId, fields: { [field]: value } }))
      );
      if (!res.ok || !res.data) {
        setApplyError(res.error ?? "Unknown error");
        return;
      }
      setApplyResult(res.data);
      handleScan(); // re-scan so fixed products drop out of the list
    });
  }

  function handleApplySellable(productIds: string[], sellable: boolean) {
    if (!instanceId) return;
    setApplyError(null);
    startApplyTransition(async () => {
      const res = await applyProductFixesAction(
        instanceId,
        productIds.map((productId) => ({ productId, fields: { Sellable: sellable } }))
      );
      if (!res.ok || !res.data) {
        setApplyError(res.error ?? "Unknown error");
        return;
      }
      setApplyResult(res.data);
      handleScan(); // re-scan so the roster reflects the new Sellable values
    });
  }

  function handleMergeCategory(fromNames: string[], toName: string) {
    if (!instanceId) return;
    setApplyError(null);
    startApplyTransition(async () => {
      const res = await mergeCategoryAction(instanceId, fromNames, toName);
      if (!res.ok || !res.data) {
        setApplyError(res.error ?? "Unknown error");
        return;
      }
      setApplyResult(res.data);
      handleScan(); // re-scan so the merged group drops out of the list
    });
  }

  function handleMergeBrand(fromNames: string[], toName: string) {
    if (!instanceId) return;
    setApplyError(null);
    startApplyTransition(async () => {
      const res = await mergeBrandAction(instanceId, fromNames, toName);
      if (!res.ok || !res.data) {
        setApplyError(res.error ?? "Unknown error");
        return;
      }
      setApplyResult(res.data);
      handleScan(); // re-scan so the merged group drops out of the list
    });
  }

  function handleMergeUOM(fromNames: string[], toName: string) {
    if (!instanceId) return;
    setApplyError(null);
    startApplyTransition(async () => {
      const res = await mergeUOMAction(instanceId, fromNames, toName);
      if (!res.ok || !res.data) {
        setApplyError(res.error ?? "Unknown error");
        return;
      }
      setApplyResult(res.data);
      handleScan(); // re-scan so the merged group drops out of the list
    });
  }

  function handleMergeTag(fromNames: string[], toName: string) {
    if (!instanceId) return;
    setApplyError(null);
    startApplyTransition(async () => {
      const res = await mergeTagAction(instanceId, fromNames, toName);
      if (!res.ok || !res.data) {
        setApplyError(res.error ?? "Unknown error");
        return;
      }
      setApplyResult(res.data);
      handleScan(); // re-scan so the merged group drops out of the list
    });
  }

  function handleApplyAttributeTemplate(templateProductId: string, targetProductIds: string[]) {
    if (!instanceId) return;
    setApplyError(null);
    startApplyTransition(async () => {
      const res = await applyAttributeTemplateAction(instanceId, templateProductId, targetProductIds);
      if (!res.ok || !res.data) {
        setApplyError(res.error ?? "Unknown error");
        return;
      }
      setApplyResult(res.data);
      handleScan(); // re-scan so the copied-into products drop out of the gap list
    });
  }

  // Category filter and search compose with AND logic: an issue or product
  // must match the selected category set (if any) AND the search substring
  // (if any) to be shown/selectable. Near-duplicate Category/UOM/Tag groups
  // are inherently a cross-category comparison, so those sections always
  // show everything regardless of either filter. Memoized so a large catalog
  // isn't re-filtered/re-grouped on every unrelated re-render (e.g. isApplying
  // flipping while a different section's fix is in flight).
  const { filteredIssues, issuesByType } = useMemo(() => {
    const filtered = (result?.issues ?? []).filter(
      (issue) => (categoryFilter.length === 0 || categoryFilter.includes(issue.category)) && matchesSearch(search, issue.sku, issue.name)
    );
    const byType = new Map<ProductAuditIssueType, ProductAuditIssue[]>();
    for (const issue of filtered) {
      const list = byType.get(issue.type) ?? [];
      list.push(issue);
      byType.set(issue.type, list);
    }
    return { filteredIssues: filtered, issuesByType: byType };
  }, [result, categoryFilter, search]);

  const filteredProducts = useMemo(
    () =>
      (result?.products ?? []).filter(
        (p) => (categoryFilter.length === 0 || categoryFilter.includes(p.category)) && matchesSearch(search, p.sku, p.name)
      ),
    [result, categoryFilter, search]
  );

  // Attribute-gap groups are scoped to one category already, so the category
  // filter applies at the group level; search narrows each group's own
  // product list (a group with nothing left to search-match is dropped).
  const filteredAttributeGaps = useMemo(
    () =>
      (result?.attributeGaps ?? [])
        .filter((g) => categoryFilter.length === 0 || categoryFilter.includes(g.category))
        .map((g) => ({ ...g, products: g.products.filter((p) => matchesSearch(search, p.sku, p.name)) }))
        .filter((g) => g.products.length > 0),
    [result, categoryFilter, search]
  );

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <ModuleHeader module={AUDIT_MODULE}>
        Pulls every product live from a connected Cin7 instance and checks it for consistency and
        accuracy gaps — missing Brand, no sales price, incomplete inventory setup, missing Revenue/COGS
        accounts, near-duplicate categories/brands/units of measure/tags, and incomplete custom-attribute values
        within a category (with a one-click copy from an existing well-filled-in product). Also lets you
        bulk-toggle Sellable. Fixes you approve are written straight back to that instance. Products only,
        for now.
      </ModuleHeader>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Instance</p>
        <div className="mt-3">
          <button
            type="button"
            onClick={handleLoadInstances}
            disabled={isLoadingInstances}
            className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            {isLoadingInstances ? "Loading…" : "Load instances"}
          </button>
          {instancesError && <p className="mt-2 text-sm text-red-600">{instancesError}</p>}
          {instances.length > 0 && (
            <div className="mt-3 flex flex-col gap-1.5">
              {instances.map((inst) => (
                <label key={inst.id} className="flex items-center gap-2 text-base">
                  <input
                    type="radio"
                    name="audit-instance"
                    checked={instanceId === inst.id}
                    onChange={() => setInstanceId(inst.id)}
                    disabled={!inst.active}
                    className="h-4 w-4"
                  />
                  {inst.name} {!inst.active && <span className="text-sm text-slate-400">(inactive)</span>}
                </label>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          onClick={handleScan}
          disabled={isScanning || !instanceId}
          className="mt-4 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {isScanning ? "Scanning…" : "Scan products"}
        </button>
        {scanError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{scanError}</p>}
      </section>

      {applyResult && (
        <section className="mt-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4">
          <p className="font-medium text-emerald-900">{applyResult.succeeded} product{applyResult.succeeded === 1 ? "" : "s"} fixed</p>
          {applyResult.failed.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-sm text-red-700">
              {applyResult.failed.map((f, i) => (
                <li key={i}>
                  {f.productId}: {f.error}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {applyError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{applyError}</p>}

      {result && (
        <section className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              {result.categories.length > 0 && (
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-slate-700">Category</p>
                    <div className="flex gap-3 text-xs text-indigo-600">
                      <button type="button" onClick={() => setCategoryFilter(result.categories)} className="hover:underline">
                        Select all
                      </button>
                      <button type="button" onClick={() => setCategoryFilter([])} className="hover:underline">
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="mt-2 flex max-h-40 flex-col gap-1 overflow-y-auto text-sm">
                    {result.categories.map((cat) => (
                      <label key={cat} className="flex items-center gap-2">
                        <input type="checkbox" checked={categoryFilter.includes(cat)} onChange={() => toggleCategoryFilter(cat)} className="h-4 w-4" />
                        {cat}
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
              </div>
            </div>

            {(categoryFilter.length > 0 || search.trim()) && (
              <p className="mt-3 text-xs text-slate-400">
                {categoryFilter.length > 0 && `Category: ${categoryFilter.map((c) => `"${c}"`).join(", ")}. `}
                {search.trim() && `Search: "${search.trim()}". `}
                Near-duplicate category/UOM/tag groups below are unaffected, since those checks compare
                across the whole catalog — attribute-completeness groups and the Sellable list do respect
                these filters.
              </p>
            )}
          </div>

          {result.duplicateCategories.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">Near-duplicate categories — {result.duplicateCategories.length} group{result.duplicateCategories.length === 1 ? "" : "s"}</p>
              <div className="mt-3 flex flex-col gap-3">
                {result.duplicateCategories.map((group, i) => (
                  <DuplicateGroupCard key={i} group={group} onMerge={handleMergeCategory} isApplying={isApplying} />
                ))}
              </div>
            </div>
          )}

          {result.duplicateBrands.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">Near-duplicate brands — {result.duplicateBrands.length} group{result.duplicateBrands.length === 1 ? "" : "s"}</p>
              <div className="mt-3 flex flex-col gap-3">
                {result.duplicateBrands.map((group, i) => (
                  <DuplicateGroupCard key={i} group={group} onMerge={handleMergeBrand} isApplying={isApplying} />
                ))}
              </div>
            </div>
          )}

          {result.duplicateUOMs.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">Near-duplicate units of measure — {result.duplicateUOMs.length} group{result.duplicateUOMs.length === 1 ? "" : "s"}</p>
              <div className="mt-3 flex flex-col gap-3">
                {result.duplicateUOMs.map((group, i) => (
                  <DuplicateGroupCard key={i} group={group} onMerge={handleMergeUOM} isApplying={isApplying} />
                ))}
              </div>
            </div>
          )}

          {result.duplicateTags.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">Near-duplicate tags — {result.duplicateTags.length} group{result.duplicateTags.length === 1 ? "" : "s"}</p>
              <div className="mt-3 flex flex-col gap-3">
                {result.duplicateTags.map((group, i) => (
                  <DuplicateGroupCard key={i} group={group} onMerge={handleMergeTag} isApplying={isApplying} />
                ))}
              </div>
            </div>
          )}

          {filteredAttributeGaps.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">
                Attribute completeness — {filteredAttributeGaps.length} categor{filteredAttributeGaps.length === 1 ? "y" : "ies"} with a gap
              </p>
              <div className="mt-3 flex flex-col gap-3">
                {filteredAttributeGaps.map((group) => (
                  <AttributeGapCard key={group.category} group={group} onApply={handleApplyAttributeTemplate} isApplying={isApplying} />
                ))}
              </div>
            </div>
          )}

          {result.products.length > 0 && (
            <SellableSection products={filteredProducts} onApply={handleApplySellable} isApplying={isApplying} />
          )}

          {ISSUE_ORDER.filter((type) => issuesByType.has(type)).map((type) => (
            <IssueTypeSection key={type} type={type} issues={issuesByType.get(type)!} onApply={handleApply} isApplying={isApplying} />
          ))}

          {filteredIssues.length === 0 &&
            filteredAttributeGaps.length === 0 &&
            result.duplicateCategories.length === 0 &&
            result.duplicateBrands.length === 0 &&
            result.duplicateUOMs.length === 0 &&
            result.duplicateTags.length === 0 && (
            <p className="text-base text-slate-500">
              {categoryFilter.length > 0 || search.trim()
                ? "No issues found for the current filter."
                : "No issues found — this catalog looks clean."}
            </p>
          )}
        </section>
      )}
    </main>
  );
}
