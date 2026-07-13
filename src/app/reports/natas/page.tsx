"use client";

import { useEffect, useState, useTransition } from "react";
import { loadNatasFilterOptionsAction, loadNatasReportAction } from "./actions";
import type { NatasFilterOptions } from "@/reports/natas-query";
import type { AggregatedNataRow, UnmappedItem } from "@/reports/natas-report";
import { Spinner } from "@/app/Spinner";
import { ReportDescription } from "../ReportDescription";

function money(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(2)}%`;
}

function sumRows(rows: AggregatedNataRow[]) {
  return rows.reduce(
    (acc, r) => ({
      individualNatas: acc.individualNatas + r.individualNatas,
      revenue: acc.revenue + r.revenue,
      packagingCost: acc.packagingCost + r.packagingCost,
      profit: acc.profit + r.profit,
    }),
    { individualNatas: 0, revenue: 0, packagingCost: 0, profit: 0 }
  );
}

export default function NatasReportPage() {
  const [options, setOptions] = useState<NatasFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [rows, setRows] = useState<AggregatedNataRow[] | null>(null);
  const [unmapped, setUnmapped] = useState<UnmappedItem[]>([]);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  useEffect(() => {
    loadNatasFilterOptionsAction().then((result) => {
      if (!result.ok) {
        setOptionsError(result.error ?? "Unknown error");
        return;
      }
      setOptions(result.data ?? null);
    });
  }, []);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handleRunReport() {
    setReportError(null);
    startRunTransition(async () => {
      const result = await loadNatasReportAction({
        instanceIds: instanceIds.length ? instanceIds : undefined,
        location: location || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
      });
      if (!result.ok) {
        setReportError(result.error ?? "Unknown error");
        return;
      }
      setRows(result.data?.rows ?? []);
      setUnmapped(result.data?.unmapped ?? []);
    });
  }

  const totals = rows ? sumRows(rows) : null;

  return (
    <>
      <ReportDescription title="Natas Sold &amp; Packaging COGS">
        Individual natas sold per Nata Type, Location, and Month — normalizing both predefined packs (e.g. &ldquo;Lisbon
        Classic 6&rdquo;, extrapolated to 6 individual natas from its own Assembly BOM) and mixed packs (individual
        singles combined with a zero-cost packaging line in the same sale). Packaging cost (Packaging + Label + Topping
        components) is split across however many natas it actually packaged, so margins compare fairly at the
        individual-nata level.
      </ReportDescription>

      <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <p className="font-medium text-slate-900">Filters</p>
        {optionsError && <p className="mt-2 text-sm text-red-600">{optionsError}</p>}
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <span className="text-sm font-medium text-slate-700">Instance(s)</span>
            <div className="mt-2 flex flex-col gap-1.5">
              {(options?.instances ?? []).map((inst) => (
                <label key={inst.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={instanceIds.includes(inst.id)} onChange={() => toggleInstance(inst.id)} className="h-4 w-4" />
                  {inst.name}
                </label>
              ))}
              {options && options.instances.length === 0 && <p className="text-sm text-slate-400">No instances connected.</p>}
            </div>
          </div>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Location</span>
            <select value={location} onChange={(e) => setLocation(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2">
              <option value="">All locations</option>
              {(options?.locations ?? []).map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">From</span>
              <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">To</span>
              <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="rounded-lg border border-slate-300 px-3 py-2" />
            </label>
          </div>
        </div>

        <button
          type="button"
          onClick={handleRunReport}
          disabled={isRunning}
          className="mt-5 rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {isRunning && <Spinner className="mr-1.5" />}
          {isRunning ? "Running…" : "Run report"}
        </button>

        {reportError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{reportError}</p>}
      </section>

      {unmapped.length > 0 && (
        <section className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-5">
          <p className="font-medium text-amber-900">
            {unmapped.length} SKU{unmapped.length === 1 ? "" : "s"} not recognized as a known Nata Type
          </p>
          <p className="mt-1 text-sm text-amber-800">
            These &ldquo;Nata&rdquo;-category sale lines didn&rsquo;t match a known flavor prefix, so they&rsquo;re
            excluded from the totals below rather than being miscounted. Add a new rule to `NATA_TYPE_RULES` in{" "}
            <code>src/reports/natas-report.ts</code> if this is a real new flavor.
          </p>
          <ul className="mt-3 flex flex-col gap-1 text-sm text-amber-900">
            {unmapped.map((u) => (
              <li key={u.sku}>
                {u.name ?? u.sku} ({u.sku}) — qty {u.quantity}
              </li>
            ))}
          </ul>
        </section>
      )}

      {rows && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="font-medium text-slate-900">
            {rows.length} row{rows.length === 1 ? "" : "s"}
          </p>
          {rows.length === 0 && <p className="mt-2 text-sm text-slate-400">No matching Nata sales.</p>}

          {rows.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4">Month</th>
                    <th className="py-2 pr-4">Location</th>
                    <th className="py-2 pr-4">Nata Type</th>
                    <th className="py-2 pr-4">Individual Natas</th>
                    <th className="py-2 pr-4">Revenue</th>
                    <th className="py-2 pr-4">Packaging COGS</th>
                    <th className="py-2 pr-4">Packaging COGS / Nata</th>
                    <th className="py-2 pr-4">Profit (net of packaging)</th>
                    <th className="py-2 pr-4">Margin % (net of packaging)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.month}|${row.location}|${row.nataType}`} className="border-b border-slate-100">
                      <td className="py-2 pr-4">{row.month}</td>
                      <td className="py-2 pr-4">{row.location}</td>
                      <td className="py-2 pr-4">{row.nataType}</td>
                      <td className="py-2 pr-4">{row.individualNatas.toLocaleString()}</td>
                      <td className="py-2 pr-4">{money(row.revenue)}</td>
                      <td className="py-2 pr-4">{money(row.packagingCost)}</td>
                      <td className="py-2 pr-4">{money(row.packagingCostPerNata)}</td>
                      <td className="py-2 pr-4">{money(row.profit)}</td>
                      <td className="py-2 pr-4">{percent(row.marginPercent)}</td>
                    </tr>
                  ))}
                </tbody>
                {totals && (
                  <tfoot>
                    <tr className="border-t border-slate-200 font-semibold text-slate-700">
                      <td className="py-2 pr-4" colSpan={3}>
                        Total
                      </td>
                      <td className="py-2 pr-4">{totals.individualNatas.toLocaleString()}</td>
                      <td className="py-2 pr-4">{money(totals.revenue)}</td>
                      <td className="py-2 pr-4">{money(totals.packagingCost)}</td>
                      <td className="py-2 pr-4">{money(totals.individualNatas > 0 ? totals.packagingCost / totals.individualNatas : null)}</td>
                      <td className="py-2 pr-4">{money(totals.profit)}</td>
                      <td className="py-2 pr-4">{percent(totals.revenue > 0 ? (totals.profit / totals.revenue) * 100 : null)}</td>
                    </tr>
                  </tfoot>
                )}
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
