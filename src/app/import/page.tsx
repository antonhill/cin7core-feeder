"use client";

import { useActionState, useState, useTransition } from "react";
import {
  downloadTemplateAction,
  importCsvAction,
  listInstancesForPicker,
  pushToCin7Action,
  type ImportActionState,
  type InstancePickerItem,
} from "./actions";

const INITIAL_STATE: ImportActionState = { status: "idle" };

const KINDS = [
  { value: "products", label: "Products (InventoryList)" },
  { value: "assembly_bom", label: "Assembly BOM" },
  { value: "production_bom", label: "Production BOM" },
];

export default function ImportPage() {
  const [state, formAction, isImportPending] = useActionState(importCsvAction, INITIAL_STATE);
  const [orgId, setOrgId] = useState("");
  const [secret, setSecret] = useState("");

  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [pushResult, setPushResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [isLoadingInstances, startLoadTransition] = useTransition();
  const [isPushPending, startPushTransition] = useTransition();

  const [downloadKind, setDownloadKind] = useState<"products" | "assembly_bom">("products");
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [isDownloading, startDownloadTransition] = useTransition();

  function handleLoadInstances() {
    setInstancesError(null);
    startLoadTransition(async () => {
      const result = await listInstancesForPicker(orgId, secret);
      if (!result.ok) {
        setInstancesError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
    });
  }

  function toggleInstance(id: string) {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  function handlePush() {
    setPushResult(null);
    startPushTransition(async () => {
      const result = await pushToCin7Action(orgId, secret, selectedIds);
      if (!result.ok) {
        setPushResult({ ok: false, message: result.error ?? "Unknown error" });
        return;
      }
      setPushResult({ ok: true, message: JSON.stringify(result.outcomes, null, 2) });
    });
  }

  function handleDownload() {
    setDownloadError(null);
    startDownloadTransition(async () => {
      const result = await downloadTemplateAction(orgId, secret, downloadKind);
      if (!result.ok || !result.csv) {
        setDownloadError(result.error ?? "Unknown error");
        return;
      }
      const blob = new Blob([result.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = result.filename ?? "export.csv";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  }

  const activeInstances = instances.filter((i) => i.active);

  return (
    <main className="mx-auto max-w-2xl p-8">
      <h1 className="text-xl font-semibold">Import Cin7 Core CSV</h1>
      <p className="mt-1 text-sm text-gray-500">
        Upload a products, assembly BOM, or production BOM export. Valid rows are committed
        immediately; invalid rows are skipped and listed below.
      </p>

      <form action={formAction} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-1 text-sm">
          Organization ID
          <input
            name="orgId"
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
            required
            className="rounded border px-3 py-2 font-mono text-xs"
            placeholder="d776b8cc-4e6f-42bc-bbd1-3d910fd3aaef"
          />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Import type
          <select name="kind" required className="rounded border px-3 py-2">
            {KINDS.map((k) => (
              <option key={k.value} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-sm">
          CSV file
          <input name="file" type="file" accept=".csv,text/csv" required className="rounded border px-3 py-2" />
        </label>

        <label className="flex flex-col gap-1 text-sm">
          Passphrase
          <input
            name="secret"
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            className="rounded border px-3 py-2"
          />
        </label>

        <button
          type="submit"
          disabled={isImportPending}
          className="rounded bg-black px-4 py-2 text-white disabled:opacity-50"
        >
          {isImportPending ? "Importing…" : "Import"}
        </button>
      </form>

      {state.status === "error" && (
        <p className="mt-6 rounded border border-red-300 bg-red-50 p-3 text-sm text-red-700">{state.message}</p>
      )}

      {state.status === "success" && state.result && (
        <div className="mt-6 rounded border border-green-300 bg-green-50 p-4 text-sm">
          <p className="font-medium">
            Batch {state.result.batchId}: {state.result.rowCount} rows, {state.result.errorCount} invalid,{" "}
            {state.result.committed ? "committed" : "nothing to commit"}.
          </p>
          {state.result.commitSummary && (
            <pre className="mt-2 whitespace-pre-wrap text-xs">{JSON.stringify(state.result.commitSummary, null, 2)}</pre>
          )}
          {state.result.invalidRows.length > 0 && (
            <div className="mt-3">
              <p className="font-medium text-red-700">Invalid rows:</p>
              <ul className="mt-1 list-disc pl-5 text-xs text-red-700">
                {state.result.invalidRows.map((r) => (
                  <li key={r.rowNumber}>
                    Row {r.rowNumber}: {r.errors.join("; ")}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-medium">Push to Cin7</h2>
        <p className="mt-1 text-xs text-gray-500">
          Push the org&apos;s current canonical data (products + Assembly BOM) to one or more connected instances.
          Uses the Organization ID and Passphrase above.
        </p>

        <button
          type="button"
          onClick={handleLoadInstances}
          disabled={isLoadingInstances || !orgId || !secret}
          className="mt-3 rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          {isLoadingInstances ? "Loading…" : "Load instances"}
        </button>

        {instancesError && <p className="mt-2 text-xs text-red-700">{instancesError}</p>}

        {instances.length > 0 && (
          <div className="mt-3 flex flex-col gap-2">
            {instances.map((inst) => (
              <label key={inst.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selectedIds.includes(inst.id)}
                  onChange={() => toggleInstance(inst.id)}
                  disabled={!inst.active}
                />
                {inst.name} {!inst.active && <span className="text-xs text-gray-400">(inactive — skipped)</span>}
              </label>
            ))}

            <div className="mt-1 flex gap-3 text-xs">
              <button type="button" onClick={() => setSelectedIds(activeInstances.map((i) => i.id))} className="underline">
                Select all
              </button>
              <button type="button" onClick={() => setSelectedIds([])} className="underline">
                Clear
              </button>
            </div>

            <button
              type="button"
              onClick={handlePush}
              disabled={isPushPending || selectedIds.length === 0}
              className="mt-2 w-fit rounded bg-black px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {isPushPending
                ? "Pushing…"
                : `Push to ${selectedIds.length} instance${selectedIds.length === 1 ? "" : "s"}`}
            </button>
          </div>
        )}
        {instances.length === 0 && !instancesError && (
          <p className="mt-2 text-xs text-gray-500">No instances loaded yet.</p>
        )}

        {pushResult && (
          <pre
            className={`mt-3 max-h-96 overflow-auto whitespace-pre-wrap text-xs ${pushResult.ok ? "text-green-700" : "text-red-700"}`}
          >
            {pushResult.message}
          </pre>
        )}
      </section>

      <section className="mt-8 border-t pt-6">
        <h2 className="text-sm font-medium">Download template</h2>
        <p className="mt-1 text-xs text-gray-500">
          Download the org&apos;s current products or Assembly BOM as a CSV in the same format as
          the import templates, to edit and reimport. This is the hub&apos;s canonical data (the
          same source pushed to every instance), not a live pull from one specific instance.
        </p>

        <div className="mt-3 flex items-center gap-2">
          <select
            value={downloadKind}
            onChange={(e) => setDownloadKind(e.target.value as "products" | "assembly_bom")}
            className="rounded border px-3 py-2 text-sm"
          >
            <option value="products">Products (InventoryList)</option>
            <option value="assembly_bom">Assembly BOM</option>
          </select>
          <button
            type="button"
            onClick={handleDownload}
            disabled={isDownloading || !orgId || !secret}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            {isDownloading ? "Preparing…" : "Download CSV"}
          </button>
        </div>
        {downloadError && <p className="mt-2 text-xs text-red-700">{downloadError}</p>}
      </section>
    </main>
  );
}
