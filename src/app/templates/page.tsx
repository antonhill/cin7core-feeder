"use client";

import { useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { downloadLiveTemplateAction, downloadTemplateAction } from "./actions";
import { ModuleHeader } from "@/app/ModuleHeader";
import { TEMPLATES_MODULE } from "@/app/module-nav";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Alert } from "@/components/ui/Alert";
import { Panel } from "@/components/ui/Panel";

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

  const picker = useInstancePicker();
  const selectedInstanceId = picker.instanceId;

  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedFilename, setDownloadedFilename] = useState<string | null>(null);
  const [isDownloading, startDownloadTransition] = useTransition();

  function handleDownload() {
    setDownloadError(null);
    setDownloadedFilename(null);
    startDownloadTransition(async () => {
      const result =
        source === "canonical"
          ? await downloadTemplateAction(kind)
          : await downloadLiveTemplateAction(selectedInstanceId ?? "", kind);
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
    <main className="mx-auto w-full max-w-4xl px-6 py-12">
      <ModuleHeader module={TEMPLATES_MODULE}>
        Download a CSV to edit and reimport, in the same column format Cin7 Core itself uses.
      </ModuleHeader>

      <Panel className="mt-10">
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Data"
            value={kind}
            onChange={(e) => {
              const nextKind = e.target.value as Kind;
              setKind(nextKind);
              if (!LIVE_CAPABLE_KINDS.includes(nextKind)) setSource("canonical");
            }}
          >
            <option value="products">Products (InventoryList)</option>
            <option value="assembly_bom">Assembly BOM</option>
            <option value="suppliers">Suppliers</option>
            <option value="supplier_addresses">Supplier Addresses</option>
            <option value="customers">Customers</option>
            <option value="customer_addresses">Customer Addresses</option>
          </Select>

          <Select
            label="Source"
            value={source}
            onChange={(e) => {
              setSource(e.target.value as Source);
              setDownloadedFilename(null);
              setDownloadError(null);
            }}
          >
            <option value="canonical">Hub canonical data</option>
            <option value="live" disabled={!LIVE_CAPABLE_KINDS.includes(kind)}>
              Live from a Cin7 instance
            </option>
          </Select>
        </div>

        {source === "canonical" && (
          <p className="mt-3 text-sm text-slate-500">
            {LIVE_CAPABLE_KINDS.includes(kind)
              ? "The hub's own data — the same source pushed to every connected instance, not a live pull, and limited to the columns the hub tracks (~10 core fields)."
              : "The hub's own data, with every column Cin7's own template has — not pushed to Cin7 yet, import-only for now."}
          </p>
        )}

        {source === "live" && (
          <div className="mt-4 rounded-md bg-slate-50 p-4">
            <p className="text-sm text-slate-500">
              Pulled live from the chosen instance, with every column Cin7&apos;s own template has —
              a genuine export, not the hub&apos;s trimmed view.
            </p>
            <div className="mt-3">
              <InstancePicker {...picker} onChange={picker.setInstanceId} />
            </div>
          </div>
        )}

        <div className="mt-6">
          <Button onClick={handleDownload} disabled={!canDownload} loading={isDownloading} className="w-full">
            {isDownloading ? "Preparing…" : "Download CSV"}
          </Button>
        </div>

        {downloadError && (
          <div className="mt-3">
            <Alert tone="danger">{downloadError}</Alert>
          </div>
        )}
        {downloadedFilename && (
          <div className="mt-3">
            <Alert tone="success">Downloaded {downloadedFilename}</Alert>
          </div>
        )}
      </Panel>
    </main>
  );
}
