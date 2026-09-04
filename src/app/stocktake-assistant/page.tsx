"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { ModuleHeader } from "@/app/ModuleHeader";
import { STOCKTAKE_MODULE } from "@/app/module-nav";
import { loadStocktakeLocationsAction, previewStocktakeAction, type StocktakePreviewData } from "./actions";
import { setBulkChecked, mergeStocktakeFile, buildStocktakeCsv, type ConfirmationLine, type StocktakeStage } from "@/reports/stocktake-assistant/build";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Panel } from "@/components/ui/Panel";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/EmptyState";

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

const STAGE_TONE: Record<StocktakeStage, BadgeTone> = {
  pick: "warning",
  pack: "info",
};

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
    const { rows, autoPlacedCount, appendedCount } = mergeStocktakeFile(previewData.originalRows, confirmationLines);
    const csv = buildStocktakeCsv(rows);
    const filename = `Stocktake_${location.replace(/[^a-zA-Z0-9]+/g, "_") || "export"}.csv`;
    triggerCsvDownload(csv, filename);
    const parts: string[] = [];
    if (autoPlacedCount > 0) parts.push(`${autoPlacedCount} product${autoPlacedCount === 1 ? "" : "s"} added straight onto its only Bin`);
    if (appendedCount > 0) parts.push(`${appendedCount} product${appendedCount === 1 ? "" : "s"} appended for manual placement (stock split across multiple Bins)`);
    setDownloadedFilename(`${filename} — ${parts.length ? parts.join(", ") : "no changes"}`);
  }

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={STOCKTAKE_MODULE}>
        Upload a Cin7 stocktake export, choose the location it covers, and see what&rsquo;s currently picked/packed
        for open orders there — stock a physical count would otherwise miss on the shelf. Nothing here writes to
        Cin7; it only builds a file for you to review and import yourself.
      </ModuleHeader>

      <PageLoadingIndicator show={isLoadingPreview} label="Reading file…" />

      <Panel className="mt-8">
        <form onSubmit={handlePreview} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-slate-700">Instance</span>
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>

            <Select
              label="Stocktake location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              disabled={!instanceId || isLoadingLocations}
              error={locationsError ?? undefined}
            >
              <option value="">{isLoadingLocations ? "Loading…" : "Choose a location"}</option>
              {locations.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </Select>

            <Input name="file" type="file" accept=".csv,text/csv" required label="Stocktake CSV" />
          </div>

          <Button type="submit" disabled={!instanceId || !location} loading={isLoadingPreview} className="self-start">
            {isLoadingPreview ? "Reading…" : "Check for picked/packed stock"}
          </Button>
        </form>
        {previewError && (
          <div className="mt-3">
            <Alert tone="danger">{previewError}</Alert>
          </div>
        )}
      </Panel>

      {previewData && (
        <Panel className="mt-6">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-4">
            <div>
              <p className="font-medium text-slate-900">
                {previewData.originalRows.length} row{previewData.originalRows.length === 1 ? "" : "s"} in the uploaded file —{" "}
                {confirmationLines.length} picked/packed line{confirmationLines.length === 1 ? "" : "s"} found at {location}
              </p>
              <p className="mt-1 text-sm text-slate-500">
                Untick anything that shouldn&rsquo;t be added, or bulk-skip a whole category below. When a product&rsquo;s stock
                sits in only one Bin in your file, the confirmed quantity is added straight onto that row; when it&rsquo;s split
                across more than one Bin, it&rsquo;s appended as a new, clearly-flagged row for you to place instead.
              </p>
            </div>
            {confirmationLines.length > 0 && (
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" type="button" onClick={() => bulkSet(false, "pick")}>
                  Skip all Picked
                </Button>
                <Button variant="secondary" size="sm" type="button" onClick={() => bulkSet(false, "pack")}>
                  Skip all Packed
                </Button>
                <Button variant="secondary" size="sm" type="button" onClick={() => bulkSet(true)}>
                  Recheck all
                </Button>
              </div>
            )}
          </div>

          {confirmationLines.length === 0 ? (
            <div className="mt-4">
              <EmptyState title="No picked or packed stock" description="No open orders currently have picked or packed stock at this location." />
            </div>
          ) : (
            <div className="mt-4">
              <Table>
                <THead>
                  <tr>
                    <TH />
                    <TH>Product</TH>
                    <TH>Status</TH>
                    <TH align="right">Quantity</TH>
                  </tr>
                </THead>
                <TBody>
                  {sortedLines.map((line) => {
                    const index = confirmationLines.indexOf(line);
                    return (
                      <TR key={`${line.productSku}-${line.stage}`}>
                        <TD>
                          <input
                            type="checkbox"
                            aria-label={`Include ${line.productName ?? line.productSku} (${stageLabel(line.stage)})`}
                            checked={line.checked}
                            onChange={() => toggleLine(index)}
                            className="h-4 w-4 rounded border-slate-300 text-primary"
                          />
                        </TD>
                        <TD>
                          <div className="font-medium text-slate-900">{line.productName ?? line.productSku}</div>
                          <div className="font-mono text-xs text-slate-400">{line.productSku}</div>
                        </TD>
                        <TD>
                          <Badge tone={STAGE_TONE[line.stage]}>{stageLabel(line.stage)}</Badge>
                        </TD>
                        <TD align="right" numeric className="font-medium">
                          {line.quantity.toLocaleString()}
                        </TD>
                      </TR>
                    );
                  })}
                </TBody>
              </Table>
            </div>
          )}

          <div className="mt-5 flex items-center justify-between border-t border-slate-100 pt-4">
            <p className="text-sm text-slate-500">
              {checkedCount} of {confirmationLines.length} line{confirmationLines.length === 1 ? "" : "s"} will be added.
            </p>
            <Button type="button" onClick={handleDownload}>
              Download stocktake file
            </Button>
          </div>
          {downloadedFilename && (
            <div className="mt-2">
              <Alert tone="success">
                Downloaded {downloadedFilename} — review the new rows and place each quantity in the right Bin before importing into Cin7.
              </Alert>
            </div>
          )}
        </Panel>
      )}
    </main>
  );
}
