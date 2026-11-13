"use client";

import { useState } from "react";
import { pageContainerClass } from "@/app/PageContainer";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { runCin7DiagnosticAction } from "../cin7-diagnostic-actions";

const MAX_SKUS = 150;

export function DiagnosticClient() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [json, setJson] = useState<string | null>(null);
  const skus = text.split("\n").map((l) => l.trim()).filter(Boolean);

  async function run() {
    setBusy(true); setError(null); setJson(null);
    try {
      const r = await runCin7DiagnosticAction(skus);
      if (r.ok && r.data) setJson(JSON.stringify(r.data, null, 2)); else setError(r.error ?? "The diagnostic could not be completed.");
    } catch { setError("The diagnostic could not be completed."); }
    setBusy(false);
  }

  return (
    <main className={pageContainerClass("data")}>
      <div className="border-b border-slate-200 pb-4">
        <h1 className="text-xl font-semibold tracking-tight text-slate-900">Cin7 read-only check</h1>
        <p className="mt-0.5 max-w-3xl text-sm leading-snug text-slate-600">Reads live Cin7 product and supplier data for the SKUs below (GET only). Nothing is written to Cin7 or to any quotation. The result contains costs: internal only.</p>
      </div>
      <Panel className="mt-4">
        <PanelTitle>SKUs (one per line, at most {MAX_SKUS})</PanelTitle>
        <textarea className="mt-2 h-48 w-full rounded-md border border-slate-300 bg-white p-2 font-mono text-sm" value={text} onChange={(e) => setText(e.target.value)} aria-label="SKUs, one per line" />
        <div className="mt-3 flex items-center gap-3">
          <Button onClick={run} loading={busy} disabled={!skus.length || skus.length > MAX_SKUS}>Run read-only check</Button>
          <span className="text-xs text-slate-600">{skus.length} SKU(s). About one request per second, so allow a minute or two for a long list.</span>
        </div>
      </Panel>
      {error && <div className="mt-4"><Alert tone="danger">{error}</Alert></div>}
      {json && (
        <Panel className="mt-4">
          <PanelTitle>Result</PanelTitle>
          <a className="mt-2 inline-block text-sm text-primary underline" download="cin7-readonly-diagnostic.json" href={`data:application/json;charset=utf-8,${encodeURIComponent(json)}`}>Download JSON</a>
          <pre className="mt-2 max-h-[32rem] overflow-auto rounded-md bg-slate-50 p-3 text-xs">{json}</pre>
        </Panel>
      )}
    </main>
  );
}
