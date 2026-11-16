"use client";

import { useState } from "react";
import { coverage, type SurveyInput, type SurveyResult } from "@/newquip/pricing/cost-survey";
import { getCostSurveyUniverseAction, surveyCin7SkusAction } from "../survey-actions";

// Read-only survey runner: asks the server for the mapped SKUs, then reads Cin7 in chunks of 10 (GET only). Nothing is saved anywhere.
export function SurveyClient() {
  const [state, setState] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [progress, setProgress] = useState("");
  const [results, setResults] = useState<SurveyResult[]>([]);
  const [inputs, setInputs] = useState<SurveyInput[]>([]);
  const [keys, setKeys] = useState<{ product: string[]; supplier: string[] }>({ product: [], supplier: [] });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [sources, setSources] = useState<Record<string, string[]>>({});

  async function run() {
    setState("running"); setResults([]); setInputs([]); setErrs({});
    const u = await getCostSurveyUniverseAction();
    if (!u.ok || !u.data) { setState("failed"); setProgress(u.error ?? "failed"); return; }
    setSources(u.data.sources);
    const all = u.data.skus; const r: SurveyResult[] = [], i: SurveyInput[] = []; const pk = new Set<string>(), sk = new Set<string>(); const e: Record<string, string> = {};
    for (let n = 0; n < all.length; n += 10) {
      setProgress(`Reading ${Math.min(n + 10, all.length)} of ${all.length} from Cin7 (read-only)`);
      const c = await surveyCin7SkusAction(all.slice(n, n + 10));
      if (!c.ok || !c.data) { setState("failed"); setProgress(c.error ?? "failed"); return; }
      r.push(...c.data.results); i.push(...c.data.inputs); c.data.productKeys.forEach((k) => pk.add(k)); c.data.supplierKeys.forEach((k) => sk.add(k)); Object.assign(e, c.data.errors);
    }
    setResults(r); setInputs(i); setErrs(e); setKeys({ product: [...pk].sort(), supplier: [...sk].sort() }); setState("done"); setProgress("");
  }

  const cov = coverage(results);
  const payload = JSON.stringify({ generatedAt: new Date().toISOString(), coverage: cov, productKeys: keys.product, supplierKeys: keys.supplier, errors: errs, sources, skus: results.map((x) => ({ ...x, unitFields: inputs.find((y) => y.sku === x.sku)?.unitFields, uom: inputs.find((y) => y.sku === x.sku)?.uom })) });
  return (
    <main className="mx-auto max-w-6xl p-4 text-slate-900">
      <h1 className="text-xl font-semibold">NewQuip cost-source survey (read-only)</h1>
      <p className="mt-1 text-sm text-slate-800">Reads Cin7 product and supplier data for the mapped SKUs. Writes nothing to Cin7, the database or any quotation. Internal: contains supplier costs.</p>
      <button type="button" onClick={run} disabled={state === "running"} className="mt-3 min-h-11 rounded-lg bg-slate-900 px-4 text-white disabled:opacity-60" data-testid="run-survey">Run survey</button>
      {progress && <p role="status" className="mt-2 text-sm">{progress}</p>}
      {state === "done" && (
        <>
          <pre className="mt-4 overflow-auto rounded bg-slate-100 p-3 text-xs" data-testid="coverage">{JSON.stringify(cov, null, 2)}</pre>
          <p className="mt-2 text-sm">Cin7 errors: {Object.keys(errs).length}. Product fields seen: {keys.product.length}. Supplier-record fields: {keys.supplier.join(", ")}</p>
          <textarea readOnly value={payload} className="mt-2 h-64 w-full rounded border p-2 font-mono text-xs" data-testid="survey-json" aria-label="Survey result JSON" />
        </>
      )}
    </main>
  );
}
