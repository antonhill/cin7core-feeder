"use client";

import { useState, useTransition } from "react";
import { runSystemHealthAction } from "./actions";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import type { DimensionResult, HealthTone, SystemHealthResult } from "@/health/system-health";

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

function DimensionCard<T>({
  dimension,
  renderItem,
  footer,
}: {
  dimension: DimensionResult<T>;
  renderItem: (item: T) => React.ReactNode;
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
        <ul className="mt-3 flex flex-col gap-1.5 text-sm text-slate-700">
          {dimension.items.map((item, i) => (
            <li key={i}>{renderItem(item)}</li>
          ))}
        </ul>
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
      <h1 className="text-3xl font-bold tracking-tight text-slate-900">System Health</h1>
      <p className="mt-2 text-lg text-slate-500">
        Scans a connected Cin7 instance across Sales, Purchases, Stock Transfers, Assemblies, Production Orders, and
        product data quality, and scores each one — plus one overall health score. Read-only; nothing is written back.
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
        <section className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <DimensionCard
            dimension={result.sales}
            renderItem={(s) => (
              <>
                {s.orderNumber} — {s.customer} <span className="text-xs text-slate-500">({s.fulfilmentStatus}, due {s.shipBy.slice(0, 10)})</span>
              </>
            )}
          />
          <DimensionCard
            dimension={result.purchases}
            renderItem={(p) => (
              <>
                {p.orderNumber} — {p.supplier}{" "}
                <span className="text-xs text-slate-500">({p.receivingStatus}, due {p.requiredBy.slice(0, 10)})</span>
              </>
            )}
          />
          <DimensionCard
            dimension={result.transfers}
            renderItem={(t) => (
              <>
                {t.number} — {t.fromLocation} → {t.toLocation} <span className="text-xs text-slate-500">({t.status})</span>
              </>
            )}
          />
          <DimensionCard
            dimension={result.assemblies}
            renderItem={(a) => (
              <>
                {a.assemblyNumber} — {a.productName} <span className="text-xs text-slate-500">({a.status})</span>
              </>
            )}
          />
          <DimensionCard
            dimension={result.productionOrders}
            renderItem={(o) => (
              <>
                {o.orderNumber} — {o.productName}{" "}
                <span className="text-xs text-slate-500">({o.status}, due {o.requiredByDate.slice(0, 10)})</span>
              </>
            )}
          />
          <DimensionCard
            dimension={result.productData}
            renderItem={(p) => (
              <>
                {p.name} <span className="text-xs text-slate-500">({p.sku})</span>
              </>
            )}
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
