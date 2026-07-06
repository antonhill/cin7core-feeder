"use client";

import { useState, useTransition } from "react";
import { listInstancesForPicker, type InstancePickerItem } from "@/actions/instances";
import { downloadLiveTemplateAction, downloadTemplateAction } from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { TEMPLATES_MODULE } from "@/app/module-nav";

type Kind = "products" | "assembly_bom" | "suppliers" | "supplier_addresses" | "customers" | "customer_addresses";
type Source = "canonical" | "live";

const LIVE_CAPABLE_KINDS: Kind[] = ["products", "assembly_bom"];

function triggerDownload(csv: string, filename: string) {
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

export default function TemplatesPage() {
  const [kind, setKind] = useState<Kind>("products");
  const [source, setSource] = useState<Source>("canonical");

  const [instances, setInstances] = useState<InstancePickerItem[]>([]);
  const [instancesError, setInstancesError] = useState<string | null>(null);
  const [selectedInstanceId, setSelectedInstanceId] = useState("");
  const [isLoadingInstances, startLoadTransition] = useTransition();

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);
  const [isDownloading, startDownloadTransition] = useTransition();

  function handleLoadInstances() {
    setInstancesError(null);
    startLoadTransition(async () => {
      const result = await listInstancesForPicker();
      if (!result.ok) {
        setInstancesError(result.error ?? "Unknown error");
        return;
      }
      setInstances(result.instances ?? []);
      if (result.instances?.length === 1) setSelectedInstanceId(result.instances[0].id);
    });
  }

  function handleDownload() {
    setDownloadError(null);
    setDownloadedFilename(null);
    startDownloadTransition(async () => {
      const result =
        source === "canonical"
          ? await downloadTemplateAction(kind)
          : await downloadLiveTemplateAction(selectedInstanceId, kind);
      if (!result.ok || !result.csv) {
        setDownloadError(result.error ?? "Unknown error");
        return;
      }
      triggerDownload(result.csv, result.filename ?? "export.csv");
      setDownloadedFilename(result.filename ?? "export.csv");
    });
  }

  const canDownload = source === "canonical" || selectedInstanceId;

  return (
    <main className="mx-auto max-w-2xl px-6 py-12">
      <ModuleHeader module={TEMPLATES_MODULE}>
        Download a CSV to edit and reimport, in the same column format Cin7 Core itself uses.
      </ModuleHeader>

      <div className="mt-10 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="grid grid-cols-2 gap-3">
          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Data</span>
            <select
              value={kind}
              onChange={(e) => {
                const nextKind = e.target.value as Kind;
                setKind(nextKind);
                if (!LIVE_CAPABLE_KINDS.includes(nextKind)) setSource("canonical");
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
            >
              <option value="products">Products (InventoryList)</option>
              <option value="assembly_bom">Assembly BOM</option>
              <option value="suppliers">Suppliers</option>
              <option value="supplier_addresses">Supplier Addresses</option>
              <option value="customers">Customers</option>
              <option value="customer_addresses">Customer Addresses</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-base">
            <span className="font-medium text-slate-700">Source</span>
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value as Source);
                setDownloadedFilename(null);
                setDownloadError(null);
              }}
              className="rounded-lg border border-slate-300 px-3 py-2 focus:border-indigo-500 focus:outline-none"
            >
              <option value="canonical">Hub canonical data</option>
              <option value="live" disabled={!LIVE_CAPABLE_KINDS.includes(kind)}>
                Live from a Cin7 instance
              </option>
            </select>
          </label>
        </div>

        {source === "canonical" && (
          <p className="mt-3 text-sm text-slate-500">
            {LIVE_CAPABLE_KINDS.includes(kind)
              ? "The hub's own data — the same source pushed to every connected instance, not a live pull, and limited to the columns the hub tracks (~10 core fields)."
              : "The hub's own data, with every column Cin7's own template has — not pushed to Cin7 yet, import-only for now."}
          </p>
        )}

        {source === "live" && (
          <div className="mt-4 rounded-xl bg-slate-50 p-4">
            <p className="text-sm text-slate-500">
              Pulled live from the chosen instance, with every column Cin7&apos;s own template has —
              a genuine export, not the hub&apos;s trimmed view.
            </p>
            <button
              type="button"
              onClick={handleLoadInstances}
              disabled={isLoadingInstances}
              className="mt-3 rounded-full border border-slate-300 px-4 py-1.5 text-sm font-medium text-slate-700 hover:bg-white disabled:opacity-50"
            >
              {isLoadingInstances ? "Loading…" : "Load instances"}
            </button>
            {instancesError && <p className="mt-2 text-sm text-red-600">{instancesError}</p>}
            {instances.length > 0 && (
              <select
                value={selectedInstanceId}
                onChange={(e) => setSelectedInstanceId(e.target.value)}
                className="mt-3 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base focus:border-indigo-500 focus:outline-none"
              >
                <option value="">Choose an instance…</option>
                {instances.map((inst) => (
                  <option key={inst.id} value={inst.id} disabled={!inst.active}>
                    {inst.name} {!inst.active ? "(inactive)" : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleDownload}
          disabled={isDownloading || !canDownload}
          className="mt-6 w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-base font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-50"
        >
          {isDownloading ? "Preparing…" : "Download CSV"}
        </button>

        {downloadError && (
          <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
            {downloadError}
          </p>
        )}
        {downloadedFilename && (
          <p className="mt-3 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
            Downloaded {downloadedFilename}
          </p>
        )}
      </div>
    </main>
  );
}
