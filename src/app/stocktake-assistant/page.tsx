"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { ModuleHeader } from "@/app/ModuleHeader";
import { STOCKTAKE_MODULE } from "@/app/module-nav";
import { loadStocktakeLocationsAction, previewStocktakeAction, type StocktakePreviewData } from "./actions";
import { setBulkChecked, mergeStocktakeFile, buildStocktakeCsv, type ConfirmationLine, type StocktakeStage } from "@/reports/stocktake-assistant/build";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";

function triggerCsvDownload(csv: string, filename: string) {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function stageLabel(stage: StocktakeStage): string {
  return stage === "pick" ? "Picked" : "Packed";
}

export default function StocktakeAssistantPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [locations, setLocations] = useState<string[]>([]);
  const [location, setLocation] = useState("");
  const [locationsError, setLocationsError] = useState<string | null>(null);
  const [isLoadingLocations, startLocationsTransition] = useTransition();

  // Only setState from inside the async callback (never synchronously in the
  // effect body) — matches fulfillment-cleanup/page.tsx's own instance-switch
  // effect. When instanceId is cleared, this just skips the fetch rather
  // than clearing state directly; a stale previous-instance location can
  // briefly remain selected in that gap, same accepted tradeoff.
  useEffect(() => {
    if (!instanceId) return;
    startLocationsTransition(async () => {
      const result = await loadStocktakeLocationsAction(instanceId);
      if (!result.ok) {
        setLocationsError(result.error ?? "Unknown error");
        setLocations([]);
        return;
      }
      setLocationsError(null);
      setLocations(result.data ?? []);
      setLocation((prev) => (result.data?.includes(prev) ? prev : ""));
    });
  }, [instanceId]);

  const [previewData, setPreviewData] = useState<StocktakePreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [isLoadingPreview, startPreviewTransition] = useTransition();
  const [confirmationLines, setConfirmationLines] = useState<ConfirmationLine[]>([]);

  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);

  function handlePreview(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!instanceId || !location) return;
    const formData = new FormData(e.currentTarget);
    setPreviewError(null);
    setDownloadedFilename(null);
    startPreviewTransition(async () => {
      const result = await previewStocktakeAction(instanceId, location, formData);
      if (!result.ok || !result.data) {
        setPreviewError(result.error ?? "Unknown error");
        setPreviewData(null);
        setConfirmationLines([]);
        return;
      }
      setPreviewData(result.data);
      setConfirmationLines(result.data.confirmationLines);
    });
  }

  function toggleLine(index: number) {
    setConfirmationLines((prev) => prev.map((l, i) => (i === index ? { ...l, checked: !l.checked } : l)));
  }

  function bulkSet(checked: boolean, stage?: StocktakeStage) {
    setConfirmationLines((prev) => setBulkChecked(prev, checked, stage));
  }

  const sortedLines = useMemo(() => {
    return [...confirmationLines].sort((a, b) => a.productSku.localeCompare(b.productSku) || a.stage.localeCompare(b.stage));
  }, [confirmationLines]);

  const checkedCount = confirmationLines.filter((l) => l.checked).length;

  function handleDownload() {
    if (!previewData) return;
    const { rows, appendedCount } = mergeStocktakeFile(previewData.originalRows, confirmationLines);
    const csv = buildStocktakeCsv(rows);
    const filename = `Stocktake_${location.replace(/[^a-zA-Z0-9]+/g, "_") || "export"}.csv`;
    triggerCsvDownload(csv, filename);
    setDownloadedFilename(`${filename} — ${appendedCount} reference row${appendedCount === 1 ? "" : "s"} appended for manual placement`);
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={STOCKTAKE_MODULE}>
        Upload a Cin7 stocktake export, choose the location it covers, and see what&rsquo;s currently picked/packed
        for open orders there — stock a physical count would otherwise miss on the shelf. Nothing here writes to
        Cin7; it only builds a file for you to review and import yourself.
      </ModuleHeader>

      <PageLoadingIndicator show={isLoadingPreview} label="Reading file…" />

      <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <form onSubmit={handlePreview} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Instance</span>
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Stocktake location</span>
              <select
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                disabled={!instanceId || isLoadingLocations}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:opacity-50"
              >
                <option value="">{isLoadingLocations ? "Loading…" : "Choose a location"}</option>
                {locations.map((l) => (
                  <option key={l} value={l}>
                    {l}
                  </option>
                ))}
              </select>
              {locationsError && <span className="text-xs text-red-600">{locationsError}</span>}
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium text-slate-700">Stocktake CSV</span>
              <input
                name="file"
                type="file"
                accept=".csv,text/csv"
                required
                className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
              />
            </label>
          </div>

          <button
            type="submit"
            disabled={isLoadingPreview || !instanceId || !location}
            className="self-start rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {isLoadingPreview && <Spinner className="mr-1.5" />}
            {isLoadingPreview ? "Reading…" : "Check for picked/packed stock"}
          </button>
        </form>
        {previewError && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{previewError}</p>}
      </section>

      {previewData && (
        <section className="mt-6 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <p className="font-medium text-slate-900">
                {previewData.originalRows.length} row{previewData.originalRows.length === 1 ? "" : "s"} in the uploaded file —{" "}
                {confirmationLines.length} picked/packed line{confirmationLines.length === 1 ? "" : "s"} found at {location}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Untick anything that shouldn&rsquo;t be added, or bulk-skip a whole category below. Confirmed lines are appended as
                new, clearly-flagged rows — every row from your uploaded file stays exactly as it was.
              </p>
            </div>
            {confirmationLines.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <button type="button" onClick={() => bulkSet(false, "pick")} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  Skip all Picked
                </button>
                <button type="button" onClick={() => bulkSet(false, "pack")} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  Skip all Packed
                </button>
                <button type="button" onClick={() => bulkSet(true)} className="rounded-full border border-slate-300 px-3 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50">
                  Recheck all
                </button>
              </div>
            )}
          </div>

          {confirmationLines.length === 0 ? (
            <p className="mt-4 text-sm text-slate-400">No open orders currently have picked or packed stock at this location.</p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="py-2 pr-4"></th>
                    <th className="py-2 pr-4">Product</th>
                    <th className="py-2 pr-4">Status</th>
                    <th className="py-2 pr-4 text-right">Quantity</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedLines.map((line) => {
                    const index = confirmationLines.indexOf(line);
                    return (
                      <tr key={`${line.productSku}-${line.stage}`} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="py-1.5 pr-4">
                          <input type="checkbox" checked={line.checked} onChange={() => toggleLine(index)} className="h-4 w-4" />
                        </td>
                        <td className="py-1.5 pr-4">
                          <div className="font-medium text-slate-900">{line.productName ?? line.productSku}</div>
                          <div className="text-xs text-slate-400">{line.productSku}</div>
                        </td>
                        <td className="py-1.5 pr-4">
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                              line.stage === "pick" ? "bg-amber-100 text-amber-700" : "bg-sky-100 text-sky-700"
                            }`}
                          >
                            {stageLabel(line.stage)}
                          </span>
                        </td>
                        <td className="py-1.5 pr-4 text-right font-medium">{line.quantity.toLocaleString()}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
            <p className="text-sm text-slate-500">
              {checkedCount} of {confirmationLines.length} line{confirmationLines.length === 1 ? "" : "s"} will be added.
            </p>
            <button
              type="button"
              onClick={handleDownload}
              className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              Download stocktake file
            </button>
          </div>
          {downloadedFilename && (
            <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
              Downloaded {downloadedFilename} — review the new rows and place each quantity in the right Bin before importing into Cin7.
            </p>
          )}
        </section>
      )}
    </main>
  );
}
