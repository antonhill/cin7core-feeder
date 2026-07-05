"use client";

import { useState, useTransition } from "react";
import { runProductAuditAction, applyProductFixesAction, mergeCategoryAction, type ApplyFixesResult } from "./actions";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import type { CategoryDuplicateGroup, ProductAuditIssue, ProductAuditIssueType, ProductAuditResult } from "@/audit/product-audit";

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
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [value, setValue] = useState("");
  const config = FIXABLE_CONFIG[type];

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => (prev.size === issues.length ? new Set() : new Set(issues.map((i) => i.productId))));
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
            onClick={() => onApply([...selected], config.field, value.trim())}
            className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            Apply to {selected.size || ""} selected
          </button>
        </div>
      )}
    </details>
  );
}

function CategoryDuplicateCard({
  group,
  onMerge,
  isApplying,
}: {
  group: CategoryDuplicateGroup;
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
        onClick={() => onMerge(group.names.map((n) => n.name).filter((name) => name !== keep), keep)}
        className="mt-2 rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        Merge the rest into &ldquo;{keep}&rdquo;
      </button>
    </div>
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

  const issuesByType = new Map<ProductAuditIssueType, ProductAuditIssue[]>();
  for (const issue of result?.issues ?? []) {
    const list = issuesByType.get(issue.type) ?? [];
    list.push(issue);
    issuesByType.set(issue.type, list);
  }

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">Data Audit</h1>
      <p className="mt-2 text-lg text-slate-500">
        Pulls every product live from a connected Cin7 instance and checks it for consistency and
        accuracy gaps — missing Brand, no sales price, incomplete inventory setup, missing Revenue/COGS
        accounts, and near-duplicate categories. Fixes you approve are written straight back to that
        instance. Products only, for now.
      </p>

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
          {result.duplicateCategories.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="font-medium text-amber-900">Near-duplicate categories — {result.duplicateCategories.length} group{result.duplicateCategories.length === 1 ? "" : "s"}</p>
              <div className="mt-3 flex flex-col gap-3">
                {result.duplicateCategories.map((group, i) => (
                  <CategoryDuplicateCard key={i} group={group} onMerge={handleMergeCategory} isApplying={isApplying} />
                ))}
              </div>
            </div>
          )}

          {ISSUE_ORDER.filter((type) => issuesByType.has(type)).map((type) => (
            <IssueTypeSection key={type} type={type} issues={issuesByType.get(type)!} onApply={handleApply} isApplying={isApplying} />
          ))}

          {result.issues.length === 0 && result.duplicateCategories.length === 0 && (
            <p className="text-base text-slate-500">No issues found — this catalog looks clean.</p>
          )}
        </section>
      )}
    </main>
  );
}
