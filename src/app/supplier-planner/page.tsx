"use client";

import { useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { loadSupplierPlanAction } from "./actions";
import { groupLinesBySupplier, type SupplierPlanLine } from "@/reports/supplier-planner/build";
import { Spinner } from "@/app/Spinner";
import { ModuleHeader } from "@/app/ModuleHeader";
import { SUPPLIER_PLANNER_MODULE } from "@/app/module-nav";

type Period = "1m" | "3m" | "6m" | "9m" | "12m";

const PERIOD_OPTIONS: { value: Period; label: string; months: number; days: number }[] = [
  { value: "1m", label: "Previous month", months: 1, days: 30 },
  { value: "3m", label: "Previous 3 months", months: 3, days: 90 },
  { value: "6m", label: "Previous 6 months", months: 6, days: 182 },
  { value: "9m", label: "Previous 9 months", months: 9, days: 274 },
  { value: "12m", label: "Previous 12 months", months: 12, days: 365 },
];

const BUFFER_OPTIONS = [0, 10, 20, 30];

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

export default function SupplierPlannerPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [period, setPeriod] = useState<Period>("3m");
  const [bufferPercent, setBufferPercent] = useState(10);
  const [needsReorderOnly, setNeedsReorderOnly] = useState(true);

  const [lines, setLines] = useState<SupplierPlanLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const visibleLines = useMemo(() => {
    if (!lines) return [];
    return needsReorderOnly ? lines.filter((l) => l.needsReorder) : lines;
  }, [lines, needsReorderOnly]);

  const grouped = useMemo(() => groupLinesBySupplier(visibleLines), [visibleLines]);

  function handleRunPlan() {
    if (!instanceId) return;
    setError(null);
    setLines(null);
    const periodOption = PERIOD_OPTIONS.find((p) => p.value === period)!;
    startRunTransition(async () => {
      const result = await loadSupplierPlanAction({
        instanceId,
        velocityDateFrom: monthsAgoIso(periodOption.months),
        velocityDateTo: todayIso(),
        periodDays: periodOption.days,
        bufferPercent,
      });
      if (!result.ok) {
        setError(result.error ?? "Unknown error");
        return;
      }
      setLines(result.data ?? []);
    });
  }

  const needsReorderCount = lines ? lines.filter((l) => l.needsReorder).length : 0;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={SUPPLIER_PLANNER_MODULE}>
        Combines each supplier&apos;s configured lead time and safety stock (Cin7&apos;s own Product Supplier Options)
        with recent sales velocity to flag which products need reordering before they run out during transit — the
        lead-time-aware workflow for imports/long-lead-time suppliers. For simple local suppliers with no meaningful
        lead time, use the Reorder Report instead.
      </ModuleHeader>

      <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Filters</p>
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance</span>
            <div className="mt-2">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Sales period</span>
            <select value={period} onChange={(e) => setPeriod(e.target.value as Period)} className="rounded-lg border border-slate-300 px-3 py-2">
              {PERIOD_OPTIONS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Buffer</span>
            <select
              value={bufferPercent}
              onChange={(e) => setBufferPercent(Number(e.target.value))}
              className="rounded-lg border border-slate-300 px-3 py-2"
            >
              {BUFFER_OPTIONS.map((b) => (
                <option key={b} value={b}>
                  +{b}%
                </option>
              ))}
            </select>
          </label>
        </div>

        <button
          type="button"
          onClick={handleRunPlan}
          disabled={isRunning || !instanceId}
          className="mt-5 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {isRunning && <Spinner className="mr-1.5" />}
          {isRunning ? "Running…" : "Run plan"}
        </button>

        {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
      </section>

      {lines && (
        <section className="mt-6 flex flex-col gap-6">
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <p className="text-sm text-slate-500">
              {visibleLines.length} line{visibleLines.length === 1 ? "" : "s"} across {grouped.size} supplier{grouped.size === 1 ? "" : "s"} —{" "}
              {needsReorderCount} need reordering at this buffer
            </p>
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="checkbox" checked={needsReorderOnly} onChange={(e) => setNeedsReorderOnly(e.target.checked)} />
              Needs reorder only
            </label>
          </div>

          {visibleLines.length === 0 && (
            <p className="rounded-2xl border border-slate-200 bg-white p-6 text-sm text-slate-400 shadow-sm">
              No products with a configured lead time match these filters.
            </p>
          )}

          {[...grouped.entries()].map(([supplierName, supplierLines]) => (
            <div key={supplierName} className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
              <p className="font-semibold text-slate-900">
                {supplierName} <span className="ml-2 text-sm font-normal text-slate-400">{supplierLines.length} line{supplierLines.length === 1 ? "" : "s"}</span>
              </p>
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      <th className="py-2 pr-4 font-medium">Product</th>
                      <th className="py-2 pr-4 font-medium">Location</th>
                      <th className="py-2 pr-4 text-right font-medium">Lead + Safety</th>
                      <th className="py-2 pr-4 text-right font-medium">On Hand</th>
                      <th className="py-2 pr-4 text-right font-medium">Reorder At</th>
                      <th className="py-2 pr-4 text-right font-medium">Suggested Qty</th>
                      <th className="py-2 pr-4 text-right font-medium">Latest Price</th>
                    </tr>
                  </thead>
                  <tbody>
                    {supplierLines.map((line) => (
                      <tr key={lineKey(line)} className={`border-b border-slate-100 ${line.needsReorder ? "bg-amber-50/50" : ""}`}>
                        <td className="py-2 pr-4">
                          <div className="font-medium text-slate-900">{line.productName}</div>
                          <div className="text-xs text-slate-400">{line.productSku}</div>
                        </td>
                        <td className="py-2 pr-4 text-slate-500">{line.locationName ?? "All locations"}</td>
                        <td className="py-2 pr-4 text-right">
                          {line.lead}+{line.safety}
                        </td>
                        <td className="py-2 pr-4 text-right">{qty(line.onHand)}</td>
                        <td className="py-2 pr-4 text-right">{qty(line.threshold)}</td>
                        <td className="py-2 pr-4 text-right font-medium">{qty(line.suggestedQty)}</td>
                        <td className="py-2 pr-4 text-right">{money(line.cost, line.currency)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
