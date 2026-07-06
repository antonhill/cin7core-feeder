"use client";

import { useState, useTransition } from "react";
import { runSystemHealthAction } from "./actions";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import type { DimensionResult, HealthTone, SystemHealthResult } from "@/health/system-health";
import { ModuleHeader } from "@/app/ModuleHeader";
import { HEALTH_MODULE } from "@/app/module-nav";

const TONE_STYLES: Record<HealthTone, { card: string; badge: string; label: string }> = {
  green: { card: "border-emerald-200 bg-emerald-50", badge: "bg-emerald-100 text-emerald-800", label: "Healthy" },
  amber: { card: "border-amber-200 bg-amber-50", badge: "bg-amber-100 text-amber-800", label: "Needs attention" },
  red: { card: "border-red-200 bg-red-50", badge: "bg-red-100 text-red-800", label: "At risk" },
};

function scoreTone(score: number): HealthTone {
  if (score >= 90) return "green";
  if (score >= 70) return "amber";
  return "red";
}

/** Shows just the date portion of an ISO timestamp; blank input (no deadline/reference date set) stays blank rather than showing "Invalid Date" or "1970-01-01". */
function dateOnly(value: string): string {
  return value ? value.slice(0, 10) : "—";
}

interface Column<T> {
  header: string;
  render: (item: T) => React.ReactNode;
}

function DimensionCard<T>({
  dimension,
  columns,
  footer,
}: {
  dimension: DimensionResult<T>;
  columns: Column<T>[];
  footer?: React.ReactNode;
}) {
  const tone = TONE_STYLES[dimension.tone];
  return (
    <details className={`rounded-xl border p-4 ${tone.card}`} open={dimension.flaggedCount > 0 && dimension.flaggedCount <= 5}>
      <summary className="flex cursor-pointer items-center justify-between gap-3">
        <span className="font-medium text-slate-900">{dimension.label}</span>
        <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${tone.badge}`}>
          {dimension.flaggedCount} / {dimension.totalScanned}
        </span>
      </summary>

      {dimension.items.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm text-slate-700">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                {columns.map((col) => (
                  <th key={col.header} className="py-1.5 pr-4 font-medium">
                    {col.header}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {dimension.items.map((item, i) => (
                <tr key={i} className="border-b border-slate-100 last:border-0">
                  {columns.map((col) => (
                    <td key={col.header} className="py-1.5 pr-4 align-top">
                      {col.render(item)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="mt-2 text-sm text-slate-500">Nothing flagged.</p>
      )}

      {footer && <div className="mt-3">{footer}</div>}
    </details>
  );
}

export default function SystemHealthPage() {
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [instanceId, setInstanceId] = useState<string | null>(null);

  const [result, setResult] = useState<SystemHealthResult | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isScanning, startScanTransition] = useTransition();

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
    startScanTransition(async () => {
      const res = await runSystemHealthAction(instanceId);
      if (!res.ok) {
        setScanError(res.error ?? "Unknown error");
        return;
      }
      setResult(res.data ?? null);
    });
  }

  const overallTone = result ? scoreTone(result.overallScore) : null;

  return (
    <main className="mx-auto max-w-4xl px-6 py-12">
      <ModuleHeader module={HEALTH_MODULE}>
        Scans a connected Cin7 instance across Sales, Purchases, Stock Transfers, Assemblies, Production Orders, and
        product data quality, and scores each one — plus one overall health score. Read-only; nothing is written back.
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
                    name="health-instance"
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
          {isScanning ? "Scanning…" : "Scan instance"}
        </button>
        {scanError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{scanError}</p>}
      </section>

      {result && overallTone && (
        <section className={`mt-6 rounded-2xl border p-6 ${TONE_STYLES[overallTone].card}`}>
          <p className="text-sm font-medium text-slate-600">Overall health score</p>
          <p className="mt-1 text-5xl font-bold text-slate-900">{result.overallScore}</p>
          <p className={`mt-2 inline-block rounded-full px-3 py-1 text-xs font-semibold ${TONE_STYLES[overallTone].badge}`}>
            {TONE_STYLES[overallTone].label}
          </p>
        </section>
      )}

      {result && (
        <section className="mt-6 flex flex-col gap-4">
          <DimensionCard
            dimension={result.sales}
            columns={[
              { header: "Order #", render: (s) => s.orderNumber },
              { header: "Customer", render: (s) => s.customer },
              { header: "Fulfilment", render: (s) => s.fulfilmentStatus },
              { header: "Ship by", render: (s) => dateOnly(s.shipBy) },
            ]}
          />
          <DimensionCard
            dimension={result.purchases}
            columns={[
              { header: "Order #", render: (p) => p.orderNumber },
              { header: "Supplier", render: (p) => p.supplier },
              { header: "Receiving status", render: (p) => p.receivingStatus },
              { header: "Required by", render: (p) => dateOnly(p.requiredBy) },
            ]}
          />
          <DimensionCard
            dimension={result.transfers}
            columns={[
              { header: "Number", render: (t) => t.number },
              { header: "From → To", render: (t) => `${t.fromLocation} → ${t.toLocation}` },
              { header: "Status", render: (t) => t.status },
              { header: "Last modified", render: (t) => dateOnly(t.lastModifiedOn) },
            ]}
          />
          <DimensionCard
            dimension={result.assemblies}
            columns={[
              { header: "Assembly #", render: (a) => a.assemblyNumber },
              { header: "Product", render: (a) => a.productName },
              { header: "Status", render: (a) => a.status },
              { header: "Assembly date", render: (a) => dateOnly(a.date) },
            ]}
          />
          <DimensionCard
            dimension={result.productionOrders}
            columns={[
              { header: "Order #", render: (o) => o.orderNumber },
              { header: "Product", render: (o) => o.productName },
              { header: "Status", render: (o) => o.status },
              { header: "Required by", render: (o) => dateOnly(o.requiredByDate) },
            ]}
          />
          <DimensionCard
            dimension={result.productData}
            columns={[
              { header: "Check", render: (i) => i.label },
              { header: "Count", render: (i) => `${i.count} ${i.unit}` },
            ]}
            footer={
              <a href="/audit" className="text-sm font-medium text-indigo-600 hover:underline">
                Open Data Audit for full details →
              </a>
            }
          />
        </section>
      )}
    </main>
  );
}
