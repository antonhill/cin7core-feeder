"use client";

import { useMemo, useState, useTransition } from "react";
import { listAssembliesAction } from "./actions";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import type { Cin7FinishedGoodsListEntry } from "@/cin7/finished-goods";

/**
 * The 4 statuses Anton asked to filter by. VOIDED is deliberately left out —
 * confirmed live (see docs/cin7-api-findings.md / finished-goods.ts) as a
 * real 5th status Cin7 uses for cancelled assembly records, but this report
 * is about builds still relevant to the business, not a cancellation log —
 * a voided assembly never shows here regardless of filter selection.
 */
const STATUS_OPTIONS = [
  { value: "DRAFT", label: "Draft", badge: "bg-slate-100 text-slate-700" },
  { value: "AUTHORISED", label: "Authorised", badge: "bg-amber-100 text-amber-800" },
  { value: "IN PROGRESS", label: "In Progress", badge: "bg-indigo-100 text-indigo-800" },
  { value: "COMPLETED", label: "Completed", badge: "bg-emerald-100 text-emerald-800" },
] as const;

const ALL_STATUS_VALUES = STATUS_OPTIONS.map((s) => s.value);

/** Shows just the date portion of an ISO timestamp; blank input stays blank rather than showing "Invalid Date". */
function dateOnly(value: string | null | undefined): string {
  return value ? value.slice(0, 10) : "—";
}

/**
 * Quantity * UnitCost — both confirmed live on the list response itself (see
 * finished-goods.ts), no per-record detail call needed. No currency symbol:
 * Cin7 doesn't expose one on this resource, so this is shown as a plain
 * formatted number rather than assuming a currency.
 */
function totalCost(entry: Cin7FinishedGoodsListEntry): number {
  return (entry.Quantity ?? 0) * (entry.UnitCost ?? 0);
}

function formatNumber(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function matchesSearch(search: string, entry: Cin7FinishedGoodsListEntry): boolean {
  if (!search.trim()) return true;
  const needle = search.trim().toLowerCase();
  return (
    (entry.AssemblyNumber ?? "").toLowerCase().includes(needle) ||
    (entry.ProductName ?? "").toLowerCase().includes(needle) ||
    (entry.ProductCode ?? "").toLowerCase().includes(needle)
  );
}

export default function AssembliesPage() {
  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [instanceId, setInstanceId] = useState<string | null>(null);

  const [assemblies, setAssemblies] = useState<Cin7FinishedGoodsListEntry[] | null>(null);
  const [scanError, setScanError] = useState<string | null>(null);
  const [isScanning, startScanTransition] = useTransition();

  const [statusFilter, setStatusFilter] = useState<Set<string>>(new Set(ALL_STATUS_VALUES));
  const [search, setSearch] = useState("");

  function toggleStatus(value: string) {
    setStatusFilter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
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
    setAssemblies(null);
    startScanTransition(async () => {
      const res = await listAssembliesAction(instanceId);
      if (!res.ok) {
        setScanError(res.error ?? "Unknown error");
        return;
      }
      setAssemblies(res.data ?? []);
    });
  }

  const filtered = useMemo(
    () =>
      (assemblies ?? [])
        .filter((a) => statusFilter.has((a.Status ?? "").trim().toUpperCase()))
        .filter((a) => matchesSearch(search, a))
        .sort((a, b) => (b.Date ?? "").localeCompare(a.Date ?? "")),
    [assemblies, statusFilter, search]
  );

  const totals = useMemo(
    () =>
      filtered.reduce(
        (acc, a) => ({ quantity: acc.quantity + (a.Quantity ?? 0), cost: acc.cost + totalCost(a) }),
        { quantity: 0, cost: 0 }
      ),
    [filtered]
  );

  return (
    <>
      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
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
                    name="assemblies-instance"
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
          {isScanning ? "Scanning…" : "Scan assemblies"}
        </button>
        {scanError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{scanError}</p>}
      </section>

      {assemblies && (
        <section className="mt-6 flex flex-col gap-4">
          <div className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-sm font-medium text-slate-700">Status</p>
                <div className="mt-2 flex flex-wrap gap-3 text-sm">
                  {STATUS_OPTIONS.map((s) => (
                    <label key={s.value} className="flex items-center gap-1.5">
                      <input type="checkbox" checked={statusFilter.has(s.value)} onChange={() => toggleStatus(s.value)} className="h-4 w-4" />
                      {s.label}
                    </label>
                  ))}
                </div>
              </div>

              <div className="flex-1 sm:max-w-xs">
                <p className="text-sm font-medium text-slate-700">Search</p>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Assembly number or product…"
                  className="mt-2 w-full rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-500">
            <p>
              {filtered.length} of {assemblies.length} assembl{assemblies.length === 1 ? "y" : "ies"} shown
            </p>
            <p className="font-medium text-slate-700">
              Total quantity: {formatNumber(totals.quantity)} · Total cost: {formatNumber(totals.cost)}
            </p>
          </div>

          {filtered.length > 0 ? (
            <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
              <table className="w-full text-left text-sm text-slate-700">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-500">
                    <th className="px-4 py-2 font-medium">Assembly #</th>
                    <th className="px-4 py-2 font-medium">Product</th>
                    <th className="px-4 py-2 font-medium">Status</th>
                    <th className="px-4 py-2 font-medium">Date</th>
                    <th className="px-4 py-2 text-right font-medium">Quantity</th>
                    <th className="px-4 py-2 text-right font-medium">Total Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((a) => {
                    const statusOption = STATUS_OPTIONS.find((s) => s.value === (a.Status ?? "").trim().toUpperCase());
                    return (
                      <tr key={a.TaskID} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2 align-top">{a.AssemblyNumber || "—"}</td>
                        <td className="px-4 py-2 align-top">
                          {a.ProductName || "—"} <span className="text-xs text-slate-400">({a.ProductCode || "—"})</span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusOption?.badge ?? "bg-slate-100 text-slate-700"}`}>
                            {statusOption?.label ?? a.Status ?? "—"}
                          </span>
                        </td>
                        <td className="px-4 py-2 align-top">{dateOnly(a.Date)}</td>
                        <td className="px-4 py-2 align-top text-right">{formatNumber(a.Quantity ?? 0)}</td>
                        <td className="px-4 py-2 align-top text-right">{formatNumber(totalCost(a))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="text-base text-slate-500">No assemblies match the current filter.</p>
          )}
        </section>
      )}
    </>
  );
}
