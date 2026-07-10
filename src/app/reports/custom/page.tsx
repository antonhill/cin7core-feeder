"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { loadReportFilterOptionsAction } from "../actions";
import {
  runCustomReportAction,
  exportCustomReportXlsxAction,
  listCustomReportsAction,
  saveCustomReportAction,
  deleteCustomReportAction,
  type SavedCustomReport,
} from "./actions";
import type { ReportFilterOptions } from "@/reports/query";
import type { CustomReportResult } from "@/reports/custom/aggregate";
import { REPORT_SOURCES, REPORT_SOURCE_KEYS, type ReportSourceKey } from "@/reports/custom/sources";
import type { CustomReportFilters } from "@/reports/custom/facts";
import type { CustomReportRow } from "@/reports/custom/aggregate";
import { compareNullable, SortHeader, type SortDirection } from "../sortable-table";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { ReportDescription } from "../ReportDescription";

/** "dim:<index>" or "measure:<index>" — a plain string rather than a fixed union, since dimensions/measures are user-chosen and vary per source. Unlike every other report here, aggregateCustomReport has no fixed row order at all (Map iteration order), so sorting matters more on this page than anywhere else. */
type CustomSortColumn = string;

function customSortValue(row: CustomReportRow, column: CustomSortColumn): string | number | null {
  if (column.startsWith("dim:")) return row.dimensionValues[Number(column.slice(4))] ?? null;
  if (column.startsWith("measure:")) return row.measureValues[Number(column.slice(8))];
  return null;
}

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

function formatMeasure(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function toggleInArray(prev: string[], value: string): string[] {
  return prev.includes(value) ? prev.filter((x) => x !== value) : [...prev, value];
}

export default function CustomReportPage() {
  const [options, setOptions] = useState<ReportFilterOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [savedReports, setSavedReports] = useState<SavedCustomReport[]>([]);
  const [savedError, setSavedError] = useState<string | null>(null);

  const [source, setSource] = useState<ReportSourceKey>("sales");
  const [dimensionKeys, setDimensionKeys] = useState<string[]>(["product"]);
  const [measureKeys, setMeasureKeys] = useState<string[]>([]);
  const [instanceIds, setInstanceIds] = useState<string[]>([]);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const [result, setResult] = useState<CustomReportResult | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [isRunning, startRunTransition] = useTransition();

  const [reportName, setReportName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isSaving, startSaveTransition] = useTransition();

  const [isExporting, startExportTransition] = useTransition();
  const [exportError, setExportError] = useState<string | null>(null);

  const [sortColumn, setSortColumn] = useState<CustomSortColumn | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

  function handleSort(column: CustomSortColumn) {
    if (column === sortColumn) setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortColumn(column);
      setSortDirection("asc");
    }
  }

  const sortedRows = useMemo(() => {
    if (!result) return [];
    if (!sortColumn) return result.rows;
    const rows = [...result.rows];
    rows.sort((a, b) => {
      const cmp = compareNullable(customSortValue(a, sortColumn), customSortValue(b, sortColumn));
      return sortDirection === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [result, sortColumn, sortDirection]);

  const sourceConfig = REPORT_SOURCES[source];

  function refreshSavedReports() {
    listCustomReportsAction().then((res) => {
      if (!res.ok) setSavedError(res.error ?? "Unknown error");
      else setSavedReports(res.data ?? []);
    });
  }

  useEffect(() => {
    loadReportFilterOptionsAction().then((res) => {
      if (!res.ok) setOptionsError(res.error ?? "Unknown error");
      else setOptions(res.data ?? null);
    });
    refreshSavedReports();
  }, []);

  // Keeps an ALREADY-shown report in sync when the instance selection
  // changes, rather than letting it silently go stale until "Run report" is
  // clicked again — matches the fix already applied to Order Fulfillment/
  // Shipping Calendar (2026-07-10). Skips entirely if no report has been
  // generated yet, since every other filter here (source/dimensions/
  // measures/dates) still stays manual-apply via Run report; an instance
  // toggle is the one exception.
  useEffect(() => {
    if (result === null) return;
    runCustomReportAction(source, dimensionKeys, measureKeys, currentFilters()).then((res) => {
      if (!res.ok) {
        setReportError(res.error ?? "Unknown error");
        return;
      }
      setReportError(null);
      setResult(res.data ?? null);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deliberately scoped to instanceIds only; source/dimensions/measures/dates stay manual-apply via Run report
  }, [instanceIds]);

  function toggleInstance(id: string) {
    setInstanceIds((prev) => toggleInArray(prev, id));
  }

  function currentFilters(): CustomReportFilters {
    return { instanceIds: instanceIds.length ? instanceIds : undefined, dateFrom: dateFrom || undefined, dateTo: dateTo || undefined };
  }

  function handleRunReport() {
    setReportError(null);
    setResult(null);
    setSortColumn(null);
    startRunTransition(async () => {
      const res = await runCustomReportAction(source, dimensionKeys, measureKeys, currentFilters());
      if (!res.ok) {
        setReportError(res.error ?? "Unknown error");
        return;
      }
      setResult(res.data ?? null);
    });
  }

  function handleSave() {
    setSaveError(null);
    startSaveTransition(async () => {
      const res = await saveCustomReportAction(reportName, source, dimensionKeys, measureKeys, currentFilters());
      if (!res.ok) {
        setSaveError(res.error ?? "Unknown error");
        return;
      }
      setReportName("");
      refreshSavedReports();
    });
  }

  function handleLoadSaved(saved: SavedCustomReport) {
    setSource(saved.source);
    setDimensionKeys(saved.dimensions);
    setMeasureKeys(saved.measures);
    setInstanceIds(saved.filters.instanceIds ?? []);
    setDateFrom(saved.filters.dateFrom ?? "");
    setDateTo(saved.filters.dateTo ?? "");
    setResult(null);
    setReportError(null);
  }

  function handleDeleteSaved(id: string) {
    deleteCustomReportAction(id).then((res) => {
      if (res.ok) refreshSavedReports();
    });
  }

  function handleExport() {
    if (!result) return;
    setExportError(null);
    startExportTransition(async () => {
      const res = await exportCustomReportXlsxAction(source, dimensionKeys, measureKeys, result);
      if (!res.ok || !res.data) {
        setExportError(res.error ?? "Unknown error");
        return;
      }
      downloadBase64File(res.data, "custom-report.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    });
  }

  const dimensionLabels = useMemo(() => dimensionKeys.map((k) => sourceConfig.dimensions.find((d) => d.key === k)?.label ?? k), [dimensionKeys, sourceConfig]);
  const measureLabels = useMemo(() => measureKeys.map((k) => sourceConfig.measures.find((m) => m.key === k)?.label ?? k), [measureKeys, sourceConfig]);

  return (
    <>
      <ReportDescription title="Custom Reports">
        Build your own report: pick a data source, choose which dimensions to group by and which
        measures to total, filter by instance and date range, then run, export, or save it for
        next time — for when the fixed reports don&rsquo;t quite match what you&rsquo;re after.
      </ReportDescription>
      <PageLoadingIndicator show={isExporting} label="Exporting to Excel…" />

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <p className="font-medium text-slate-900">Saved reports</p>
        {savedError && <p className="mt-2 text-sm text-red-600">{savedError}</p>}
        {savedReports.length === 0 && <p className="mt-2 text-sm text-slate-400">None saved yet.</p>}
        {savedReports.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {savedReports.map((saved) => (
              <div key={saved.id} className="flex items-center gap-2 rounded-full border border-slate-200 py-1 pl-3.5 pr-2 text-sm">
                <button type="button" onClick={() => handleLoadSaved(saved)} className="font-medium text-indigo-700 hover:underline">
                  {saved.name}
                </button>
                <span className="text-xs text-slate-400">{REPORT_SOURCES[saved.source].label}</span>
                <button
                  type="button"
                  onClick={() => handleDeleteSaved(saved.id)}
                  className="rounded-full px-1.5 text-xs text-slate-400 hover:bg-slate-100 hover:text-red-600"
                  aria-label={`Delete ${saved.name}`}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="mt-6">
        <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="font-medium text-slate-900">Build a report</p>

          <label className="mt-4 flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-slate-700">Data source</span>
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value as ReportSourceKey);
                setDimensionKeys([]);
                setMeasureKeys([]);
                setResult(null);
              }}
              className="w-full max-w-xs rounded-lg border border-slate-300 px-3 py-2"
            >
              {REPORT_SOURCE_KEYS.map((key) => (
                <option key={key} value={key}>
                  {REPORT_SOURCES[key].label}
                </option>
              ))}
            </select>
          </label>

          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <span className="text-sm font-medium text-slate-700">Group by (dimensions)</span>
              <div className="mt-2 flex flex-col gap-1.5">
                {sourceConfig.dimensions.map((dim) => (
                  <label key={dim.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={dimensionKeys.includes(dim.key)}
                      onChange={() => setDimensionKeys((prev) => toggleInArray(prev, dim.key))}
                      className="h-4 w-4"
                    />
                    {dim.label}
                  </label>
                ))}
              </div>
            </div>

            <div>
              <span className="text-sm font-medium text-slate-700">Measures</span>
              <div className="mt-2 flex flex-col gap-1.5">
                {sourceConfig.measures.map((measure) => (
                  <label key={measure.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={measureKeys.includes(measure.key)}
                      onChange={() => setMeasureKeys((prev) => toggleInArray(prev, measure.key))}
                      className="h-4 w-4"
                    />
                    {measure.label}
                  </label>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-4 border-t border-slate-100 pt-4 sm:grid-cols-2">
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

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleRunReport}
              disabled={isRunning || (!dimensionKeys.length && !measureKeys.length)}
              className="rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
            >
              {isRunning && <Spinner className="mr-1.5" />}
              {isRunning ? "Running…" : "Run report"}
            </button>

            <input
              type="text"
              value={reportName}
              onChange={(e) => setReportName(e.target.value)}
              placeholder="Name this report to save it"
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
            />
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || !reportName.trim()}
              className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {isSaving ? "Saving…" : "Save"}
            </button>
          </div>

          {reportError && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{reportError}</p>}
          {saveError && <p className="mt-2 text-sm text-red-600">{saveError}</p>}
          {optionsError && <p className="mt-2 text-sm text-red-600">{optionsError}</p>}
        </section>

        {result && (
          <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="font-medium text-slate-900">
                {result.rows.length} row{result.rows.length === 1 ? "" : "s"}
              </p>
              {result.rows.length > 0 && (
                <button
                  type="button"
                  onClick={handleExport}
                  disabled={isExporting}
                  className="rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {isExporting ? "Exporting…" : "Export to Excel"}
                </button>
              )}
            </div>
            {exportError && <p className="mt-2 text-sm text-red-600">{exportError}</p>}
            {result.rows.length === 0 && <p className="mt-2 text-sm text-slate-400">No data matches these filters.</p>}

            {result.rows.length > 0 && (
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-slate-200 text-slate-500">
                      {dimensionLabels.map((label, i) => (
                        <SortHeader
                          key={label}
                          label={label}
                          column={`dim:${i}`}
                          sortColumn={sortColumn ?? ""}
                          sortDirection={sortDirection}
                          onSort={handleSort}
                        />
                      ))}
                      {measureLabels.map((label, i) => (
                        <SortHeader
                          key={label}
                          label={label}
                          column={`measure:${i}`}
                          align="right"
                          sortColumn={sortColumn ?? ""}
                          sortDirection={sortDirection}
                          onSort={handleSort}
                        />
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sortedRows.map((row, i) => (
                      <tr key={i} className="border-b border-slate-100">
                        {row.dimensionValues.map((value, j) => (
                          <td key={j} className="py-2 pr-4">
                            {value}
                          </td>
                        ))}
                        {row.measureValues.map((value, j) => (
                          <td key={j} className="py-2 pr-4 text-right">
                            {formatMeasure(value)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-slate-200 font-semibold text-slate-700">
                      <td className="py-2 pr-4" colSpan={Math.max(dimensionLabels.length, 1)}>
                        Total
                      </td>
                      {result.totals.map((value, j) => (
                        <td key={j} className="py-2 pr-4 text-right">
                          {formatMeasure(value)}
                        </td>
                      ))}
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}
