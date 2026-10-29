"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatSast } from "@/lib/approvals/time";
import { clearManualCostEstimateAction, captureLatestCostsAction, getQuoteCostEstimateAction, setManualCostEstimateAction, type QuoteCostView } from "../cost-actions";
import { fmtCents } from "../fields";

// INTERNAL physical-SKU cost estimate. The page mounts it only for a viewer who may see costs (owner/admin, or an explicit Estimator / Manager); the server
// re-checks every action. Cin7 latest cost by default; a missing cost is shown as MISSING and flags the margin incomplete; a manual estimate needs a reason and
// is labelled MANUAL. Once the quotation is approved the estimate is frozen.
//
// The panel NEVER disappears: while loading it says so, and if the server refuses or fails it shows the reason with a retry, instead of silently rendering
// nothing (which previously hid the Capture button without any explanation).

export interface CostPanelBodyProps {
  v: QuoteCostView | null; loading: boolean; error: string | null; note: string | null; busy: boolean;
  manual: { sku: string; rand: string; reason: string } | null;
  onCapture: () => void; onRetry: () => void; onClearManual: (sku: string) => void;
  onStartManual: (sku: string) => void; onManualChange: (m: { sku: string; rand: string; reason: string } | null) => void; onSaveManual: () => void;
}

export function CostPanelBody(p: CostPanelBodyProps) {
  const { v, error, note, busy, manual } = p;
  const e = v?.estimate ?? null;
  const noSkus = !!v && !v.frozen && (!e || e.lines.length === 0);
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <PanelTitle>Cin7 latest cost - capture and margin (physical SKUs)</PanelTitle>
        {v && (v.frozen ? <Badge tone="info">Frozen with the approval</Badge> : <Badge tone="neutral">Draft</Badge>)}
      </div>
      <p className="mt-1 text-xs text-slate-500">Internal. This is separate from the workbook-basis margin above; the two are not combined. {v?.note ?? ""} A missing cost is never treated as zero, and a manual estimate is always labelled as one.</p>
      {p.loading && !v && !error && <p className="mt-2 text-sm text-slate-600">Loading the cost estimate…</p>}
      {error && (
        <div className="mt-2 space-y-2">
          <Alert tone="danger">{error}</Alert>
          <Button size="sm" variant="secondary" disabled={busy} onClick={p.onRetry}>Try again</Button>
        </div>
      )}
      {note && <div className="mt-2"><Alert tone="success">{note}</Alert></div>}
      {v?.canCapture && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || noSkus} loading={busy} onClick={p.onCapture}>Capture latest costs from Cin7</Button>
          {noSkus && <span className="text-xs text-amber-700">No physical SKUs yet: map the packages to Cin7 SKUs in the physical scope first, then capture.</span>}
          {!noSkus && <span className="text-xs text-slate-500">Reads Cin7 only (no writes). Changing the costs withdraws the estimator&apos;s sign-off until it is given again.</span>}
        </div>
      )}
      {v && (!e || e.lines.length === 0 ? <p className="mt-2 text-sm text-slate-600">{v.frozen ? "No physical costs were captured before approval." : "No physical SKUs yet - resolve the package mappings first."}</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 pr-3">SKU</th><th className="pr-3 text-right">Qty</th><th className="pr-3 text-right">Unit cost</th><th className="pr-3 text-right">Total</th><th className="pr-3">Source</th><th className="pr-3">Read</th><th /></tr></thead>
            <tbody>
              {e.lines.map((l) => (
                <tr key={l.sku} className="border-t border-slate-100 align-top">
                  <td className="py-1 pr-3"><span className="font-medium">{l.sku}</span><div className="text-xs text-slate-500">{l.description}</div></td>
                  <td className="pr-3 text-right tabular-nums">{l.quantity}</td>
                  <td className="pr-3 text-right tabular-nums">{l.unitCostCents === null ? <Badge tone="danger">Missing cost</Badge> : fmtCents(l.unitCostCents)}</td>
                  <td className="pr-3 text-right tabular-nums">{l.totalCostCents === null ? "-" : fmtCents(l.totalCostCents)}</td>
                  <td className="pr-3 text-xs">{l.status === "LATEST" ? `Cin7 latest${l.supplier ? ` (${l.supplier})` : ""}` : l.status === "MANUAL" ? <span title={l.reason ?? ""}>Manual estimate: {l.reason}</span> : "-"}</td>
                  <td className="pr-3 text-xs text-slate-500">{l.retrievedAt ? formatSast(l.retrievedAt) : "-"}</td>
                  <td>{v.canCapture && (l.status === "MISSING" || l.status === "MANUAL") && (l.status === "MANUAL"
                    ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => p.onClearManual(l.sku)}>Remove</Button>
                    : <Button size="sm" variant="secondary" disabled={busy} onClick={() => p.onStartManual(l.sku)}>Add manual estimate</Button>)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {manual && (
        <div className="mt-3 grid items-end gap-2 sm:grid-cols-[8rem_8rem_1fr_auto]">
          <div className="text-sm font-medium">{manual.sku}</div>
          <Input label="Unit cost (R)" value={manual.rand} inputMode="decimal" onChange={(ev) => p.onManualChange({ ...manual, rand: ev.target.value })} />
          <Input label="Reason (required)" value={manual.reason} onChange={(ev) => p.onManualChange({ ...manual, reason: ev.target.value })} />
          <Button size="sm" disabled={busy || !/^\d+(\.\d{1,2})?$/.test(manual.rand.trim()) || manual.reason.trim().length < 5} onClick={p.onSaveManual}>Save</Button>
        </div>
      )}
      {e && (
        <div className="mt-3 text-sm">
          <div>Estimated physical cost: <strong className="tabular-nums">{fmtCents(e.totalCostCents)}</strong>{e.incomplete && <span className="ml-1 text-amber-700">(incomplete)</span>}</div>
          {v!.contractCents != null && <div>Contract (ex VAT): <span className="tabular-nums">{fmtCents(v!.contractCents)}</span></div>}
          {v!.complete ? <div>Margin on physical cost: <strong className="tabular-nums">{v!.marginPct}%</strong> (gross profit {fmtCents(v!.gpCents!)})</div>
            : <div className="text-amber-700">Margin is incomplete: {e.missingSkus.length ? `${e.missingSkus.length} SKU(s) have no cost` : ""}{e.missingSkus.length && e.unresolvedPackages.length ? " and " : ""}{e.unresolvedPackages.length ? `${e.unresolvedPackages.length} package(s) are not mapped to Cin7 SKUs` : ""}. A partial total is never shown as the margin.</div>}
        </div>
      )}
    </Panel>
  );
}

export function CostPanel({ quoteId, reload }: { quoteId: string; reload?: () => void }) {
  const [v, setV] = useState<QuoteCostView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ sku: string; rand: string; reason: string } | null>(null);

  const load = useCallback(() => {
    getQuoteCostEstimateAction(quoteId).then((r) => {
      if (r.ok && r.data) { setV(r.data); setError(null); } else setError(r.error ?? "The cost estimate could not be read.");
    });
  }, [quoteId]);
  useEffect(load, [load]);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true); setError(null); setNote(null);
    const r = await fn(); setBusy(false);
    if (!r.ok) { setError(r.error ?? "Failed"); return; }
    setNote(done); setManual(null); load(); reload?.();
  };
  return (
    <CostPanelBody
      v={v} loading={!v && !error} error={error} note={note} busy={busy} manual={manual}
      onRetry={() => { setError(null); load(); }}
      onCapture={() => run(() => captureLatestCostsAction(quoteId), "Latest costs read from Cin7 (read-only). The estimator's sign-off, if any, must be given again on the new costs.")}
      onClearManual={(sku) => run(() => clearManualCostEstimateAction(quoteId, sku), "Manual estimate removed.")}
      onStartManual={(sku) => setManual({ sku, rand: "", reason: "" })}
      onManualChange={setManual}
      onSaveManual={() => { if (!manual) return; const [w, f = ""] = manual.rand.trim().split("."); run(() => setManualCostEstimateAction(quoteId, manual.sku, Number(w) * 100 + Number(f.padEnd(2, "0")), manual.reason), "Manual estimate recorded."); }}
    />
  );
}
