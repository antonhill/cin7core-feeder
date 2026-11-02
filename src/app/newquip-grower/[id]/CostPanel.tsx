"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { formatSast } from "@/lib/approvals/time";
import {
  acceptIncompleteCostsAction, clearManualCostEstimateAction, captureLatestCostsAction, confirmUnitBasisAction, getQuoteCostEstimateAction, recalculateCostsAction, recordFxRateAction,
  selectSupplierAction, setManualCostEstimateAction, type QuoteCostView,
} from "../cost-actions";
import { fmtCents } from "../fields";
import type { QuoteDraft } from "@/newquip/grower/draft";
import { latestOnly } from "@/newquip/grower/preview-draft";
import type { SupplierOption } from "@/lib/projects/supplier-price";

// INTERNAL physical-SKU cost estimate from Cin7 LATEST SUPPLIER PRICES, across every supplier, in ZAR. The page mounts it only for a viewer who may see costs
// (owner/admin, or an explicit Estimator / Manager); the server re-checks every action. A missing cost is MISSING and flags the margin incomplete; a manual estimate
// needs a reason and is labelled MANUAL. Once the quotation is approved the estimate (with the supplier, original price, currency and rate) is frozen.
//
// The panel NEVER disappears: while loading it says so, and if the server refuses or fails it shows the reason with a retry.

export interface CostPanelBodyProps {
  v: QuoteCostView | null; loading: boolean; error: string | null; note: string | null; busy: boolean;
  /** The quotation has unsaved edits: this panel reflects the SAVED draft only. */
  unsaved?: boolean;
  manual: { sku: string; rand: string; reason: string } | null;
  onCapture: (replaceSelections?: boolean) => void; onRetry: () => void; onClearManual: (sku: string) => void;
  onStartManual: (sku: string) => void; onManualChange: (m: { sku: string; rand: string; reason: string } | null) => void; onSaveManual: () => void;
  onSelect?: (sku: string, supplier: { supplierId: string | null; supplierName: string | null }, reason: string) => void;
  onRecalculate?: () => void; onRecordFx?: (currency: string, rate: string, source: string, asOfIso: string) => void;
  onConfirmUnit?: (reason: string) => void; onAcceptIncomplete?: (reason: string) => void;
}

const price = (micro: number | null, cur: string | null) => (micro === null ? "-" : `${cur ?? "?"} ${(micro / 1_000_000).toLocaleString("en-ZA", { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`);
const key = (o: SupplierOption) => `${o.supplierId ?? ""}|${o.supplierName ?? ""}`;
const ISSUE: Record<string, string> = { NEEDS_CHOICE: "Choose a supplier", PREFERRED_INVALID: "Preferred supplier has no usable price", NO_USABLE_PRICE: "No usable supplier price" };

function SupplierChooser({ sku, opts, selectedKey, busy, onSelect }: { sku: string; opts: SupplierOption[]; selectedKey: string | null; busy: boolean; onSelect?: CostPanelBodyProps["onSelect"] }) {
  const [reason, setReason] = useState("");
  return (
    <div className="mt-1 rounded border border-slate-200 bg-slate-50 p-2" aria-label={`Suppliers for ${sku}`}>
      <ul className="space-y-1">
        {opts.map((o) => (
          <li key={key(o)} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
            <label className="flex items-center gap-1">
              <input type="radio" name={`sup-${sku}`} disabled={busy || o.status !== "USABLE" || !onSelect} checked={selectedKey === key(o)} onChange={() => onSelect?.(sku, { supplierId: o.supplierId, supplierName: o.supplierName }, reason)} />
              <span className="font-medium">{o.supplierName ?? o.supplierId ?? "(unnamed supplier)"}</span>{o.preferred ? <Badge tone="info">Preferred</Badge> : null}
            </label>
            <span className="tabular-nums">{price(o.priceMicro, o.currency)}</span>
            {o.fx && <span className="text-slate-500">x {o.fx.rate} ({o.fx.source}, {formatSast(o.fx.asOf)})</span>}
            <span className="tabular-nums">{o.zarUnitCents === null ? <Badge tone="danger">Unusable</Badge> : `= ${fmtCents(o.zarUnitCents)} / unit`}</span>
            <span className="text-slate-500">{o.lastSupplied ? `last supplied ${o.lastSuppliedValid ? o.lastSupplied.slice(0, 10) : "(date unreadable)"}` : ""}</span>
            {o.problems.filter((p) => p.blocking).map((p, i) => <span key={i} className="text-red-700">{p.message}</span>)}
          </li>
        ))}
      </ul>
      {onSelect && opts.length > 1 && <div className="mt-1 max-w-sm"><Input label="Reason (needed when changing the supplier or choosing against the preference)" value={reason} onChange={(e) => setReason(e.target.value)} /></div>}
    </div>
  );
}

function FxForm({ v, busy, onRecordFx }: { v: QuoteCostView; busy: boolean; onRecordFx?: CostPanelBodyProps["onRecordFx"] }) {
  const [f, setF] = useState({ currency: "USD", rate: "", source: "", asOf: "" });
  const rates = Object.values(v.fx);
  return (
    <div className="mt-3 rounded border border-slate-200 p-2 text-xs">
      <div className="font-medium">Exchange rates (ZAR per 1 unit) - recorded, never assumed</div>
      {!v.fxAvailable && <div className="text-amber-700">Exchange-rate snapshots are not available yet (database migration pending): only ZAR supplier prices can be used.</div>}
      {rates.length === 0 ? <div className="text-slate-600">No foreign-currency rate is recorded. A foreign supplier price stays unusable until one is.</div> : (
        <ul className="mt-1">{rates.map((r) => <li key={r.currency} className="tabular-nums">{r.currency}: {r.rate} - {r.source} - effective {formatSast(r.asOf)}</li>)}</ul>
      )}
      {v.fxAvailable && onRecordFx && (
        <div className="mt-2 grid items-end gap-2 sm:grid-cols-[5rem_6rem_1fr_11rem_auto]">
          <Input label="Currency" value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} />
          <Input label="Rate" value={f.rate} inputMode="decimal" onChange={(e) => setF({ ...f, rate: e.target.value })} />
          <Input label="Source (provider, fixing or quote)" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
          <Input label="Effective (date and time)" type="datetime-local" value={f.asOf} onChange={(e) => setF({ ...f, asOf: e.target.value })} />
          <Button size="sm" disabled={busy || !f.rate || f.source.trim().length < 3 || !f.asOf} onClick={() => onRecordFx(f.currency, f.rate, f.source, new Date(f.asOf).toISOString())}>Record rate</Button>
        </div>
      )}
      <div className="mt-1 text-slate-500">A rate older than {v.maxRateAgeHours} hours is refused as stale. The rate used by a quotation is frozen into its estimate at approval.</div>
    </div>
  );
}

function Declarations({ v, busy, onConfirmUnit, onAcceptIncomplete }: { v: QuoteCostView; busy: boolean; onConfirmUnit?: CostPanelBodyProps["onConfirmUnit"]; onAcceptIncomplete?: CostPanelBodyProps["onAcceptIncomplete"] }) {
  const [unitReason, setUnitReason] = useState(""); const [exception, setException] = useState("");
  return (
    <div className="mt-3 grid gap-3 text-xs md:grid-cols-2">
      <div className="rounded border border-slate-200 p-2">
        <div className="font-medium">Unit of measure</div>
        {v.unitBasis ? <div className="text-slate-700">Confirmed per stock unit by {v.unitBasis.confirmedBy} ({formatSast(v.unitBasis.confirmedAt)}): {v.unitBasis.reason}</div> : (
          <>
            <div className="text-amber-700">Cin7 does not say which unit a supplier price is for. Until someone confirms the prices are per stock unit, they are unusable.</div>
            {onConfirmUnit && !v.frozen && (
              <div className="mt-1 flex items-end gap-2"><div className="flex-1"><Input label="How do you know? (required)" value={unitReason} onChange={(e) => setUnitReason(e.target.value)} /></div><Button size="sm" variant="secondary" disabled={busy || unitReason.trim().length < 10} onClick={() => onConfirmUnit(unitReason)}>Confirm per stock unit</Button></div>
            )}
          </>
        )}
      </div>
      <div className="rounded border border-slate-200 p-2">
        <div className="font-medium">Incomplete estimate</div>
        {v.incompleteAccepted ? <div className="text-slate-700">Exception accepted by {v.incompleteAccepted.by} ({formatSast(v.incompleteAccepted.at)}): {v.incompleteAccepted.reason}</div> : (
          <>
            <div className="text-slate-600">Approval is refused while a captured estimate is incomplete, unless an authorised exception is recorded.</div>
            {onAcceptIncomplete && !v.frozen && (
              <div className="mt-1 flex items-end gap-2"><div className="flex-1"><Input label="Exception reason (required)" value={exception} onChange={(e) => setException(e.target.value)} /></div><Button size="sm" variant="secondary" disabled={busy || exception.trim().length < 10} onClick={() => onAcceptIncomplete(exception)}>Record exception</Button></div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function CostPanelBody(p: CostPanelBodyProps) {
  const { v, error, note, busy, manual } = p;
  const e = v?.estimate ?? null;
  const noSkus = !!v && !v.frozen && (!e || e.lines.length === 0);
  const stale = !!v && Object.values(v.skuOptions).some((o) => o.needsRecalculation);
  return (
    <Panel>
      <div className="flex flex-wrap items-center gap-2">
        <PanelTitle>Cin7 latest cost - capture and margin (physical SKUs)</PanelTitle>
        {v && (v.frozen ? <Badge tone="info">Frozen with the approval</Badge> : <Badge tone="neutral">Draft</Badge>)}
      </div>
      {p.unsaved && <div className="mt-2"><Alert tone="warning">Unsaved changes. This estimate is a live preview of your edits (nothing is saved). Capturing or selecting supplier prices works on the SAVED draft: save first.</Alert></div>}
      <p className="mt-1 text-xs text-slate-500">Internal. Latest Supplier Price from Cin7 for every supplier, in rand. This is separate from the workbook-basis margin above; the two are not combined. {v?.note ?? ""} A missing cost is never treated as zero, FixedCost and AverageCost are never substituted, and a manual estimate is always labelled as one.</p>
      {p.loading && !v && !error && <p className="mt-2 text-sm text-slate-600">Loading the cost estimate…</p>}
      {error && (
        <div className="mt-2 space-y-2">
          <Alert tone="danger">{error}</Alert>
          <Button size="sm" variant="secondary" disabled={busy} onClick={p.onRetry}>Try again</Button>
        </div>
      )}
      {note && <div className="mt-2"><Alert tone="success">{note}</Alert></div>}
      {stale && (
        <div className="mt-2 flex flex-wrap items-center gap-2"><Alert tone="warning">An exchange rate or declaration has changed since these costs were captured.</Alert>{p.onRecalculate && <Button size="sm" variant="secondary" disabled={busy} onClick={p.onRecalculate}>Recalculate with current rates</Button>}</div>
      )}
      {v?.canCapture && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={busy || noSkus} loading={busy} onClick={() => p.onCapture(false)}>Capture latest costs from Cin7</Button>
          {noSkus && <span className="text-xs text-amber-700">No physical SKUs yet: map the packages to Cin7 SKUs in the physical scope first, then capture.</span>}
          {!noSkus && <span className="text-xs text-slate-500">Reads Cin7 only (no writes). Your supplier selections and manual estimates are kept. Changing the costs withdraws the estimator&apos;s sign-off until it is given again.</span>}
          {!noSkus && <Button size="sm" variant="secondary" disabled={busy} onClick={() => { if (typeof window === "undefined" || window.confirm("Re-read Cin7 AND discard every supplier selection you made? Manual estimates are kept.")) p.onCapture(true); }}>Capture and replace my selections</Button>}
        </div>
      )}
      {v && !v.frozen && <FxForm v={v} busy={busy} onRecordFx={p.onRecordFx} />}
      {v && <Declarations v={v} busy={busy} onConfirmUnit={p.onConfirmUnit} onAcceptIncomplete={p.onAcceptIncomplete} />}
      {v && (!e || e.lines.length === 0 ? <p className="mt-2 text-sm text-slate-600">{v.frozen ? "No physical costs were captured before approval." : "No physical SKUs yet - resolve the package mappings first."}</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-xs text-slate-500"><th className="py-1 pr-3">SKU</th><th className="pr-3 text-right">Qty</th><th className="pr-3">Supplier</th><th className="pr-3 text-right">Supplier price</th><th className="pr-3 text-right">ZAR unit cost</th><th className="pr-3 text-right">Total</th><th className="pr-3">Status</th><th /></tr></thead>
            <tbody>
              {e.lines.map((l) => {
                const so = v.skuOptions[l.sku];
                const multi = !!so && so.options.length > 0;
                return (
                  <tr key={l.sku} className="border-t border-slate-100 align-top">
                    <td className="py-1 pr-3"><span className="font-medium">{l.sku}</span><div className="text-xs text-slate-500">{l.description}</div>
                      {multi && (v.canCapture || !v.frozen) && <SupplierChooser sku={l.sku} opts={so!.options} selectedKey={so!.selection ? `${so!.selection.supplierId ?? ""}|${so!.selection.supplierName ?? ""}` : null} busy={busy} onSelect={v.canCapture ? p.onSelect : undefined} />}
                    </td>
                    <td className="pr-3 text-right tabular-nums">{l.quantity}</td>
                    <td className="pr-3 text-xs">{l.supplier ?? "-"}{so?.selection ? <div className="text-slate-500">{so.selection.method === "AUTO_SINGLE" ? "automatic (only supplier)" : so.selection.method === "PREFERRED" ? "preferred supplier" : `chosen by estimator${so.selection.reason ? `: ${so.selection.reason}` : ""}`}</div> : null}{!so && l.basis ? <div className="text-slate-500">{l.basis.selectionMethod === "AUTO_SINGLE" ? "automatic (only supplier)" : l.basis.selectionMethod === "PREFERRED" ? "preferred supplier" : "chosen by estimator"}</div> : null}</td>
                    <td className="pr-3 text-right text-xs tabular-nums">{l.basis ? <>{price(l.basis.originalPriceMicro, l.basis.currency)}{l.basis.fx && <div className="text-slate-500">x {l.basis.fx.rate}</div>}</> : so?.selection ? (() => { const o = so.options.find((x) => key(x) === `${so.selection!.supplierId ?? ""}|${so.selection!.supplierName ?? ""}`); return o ? <>{price(o.priceMicro, o.currency)}{o.fx && <div className="text-slate-500">x {o.fx.rate}</div>}</> : "-"; })() : "-"}</td>
                    <td className="pr-3 text-right tabular-nums">{l.unitCostCents === null ? <Badge tone="danger">Missing cost</Badge> : fmtCents(l.unitCostCents)}</td>
                    <td className="pr-3 text-right tabular-nums">{l.totalCostCents === null ? "-" : fmtCents(l.totalCostCents)}</td>
                    <td className="pr-3 text-xs">{l.status === "LATEST" ? "Cin7 supplier price" : l.status === "MANUAL" ? <span title={l.reason ?? ""}>Manual estimate: {l.reason}</span> : <span className="text-amber-700">{(l.issue && ISSUE[l.issue]) ?? "No cost"}{so?.message ? ` - ${so.message}` : ""}</span>}{l.retrievedAt ? <div className="text-slate-500">read {formatSast(l.retrievedAt)}</div> : null}</td>
                    <td>{v.canCapture && (l.status === "MISSING" || l.status === "MANUAL") && (l.status === "MANUAL"
                      ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => p.onClearManual(l.sku)}>Remove</Button>
                      : <Button size="sm" variant="secondary" disabled={busy} onClick={() => p.onStartManual(l.sku)}>Add manual estimate</Button>)}</td>
                  </tr>
                );
              })}
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

export function CostPanel({ quoteId, reload, unsaved, previewDraft }: { quoteId: string; reload?: () => void; unsaved?: boolean; previewDraft?: QuoteDraft | null }) {
  const [v, setV] = useState<QuoteCostView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState<{ sku: string; rand: string; reason: string } | null>(null);

  // The estimate follows the UNSAVED edits (read-only server preview, same builders); an answer to an older request never overwrites a newer one.
  const latest = useRef(latestOnly());
  const draftRef = useRef(previewDraft ?? null);
  useEffect(() => { draftRef.current = previewDraft ?? null; }, [previewDraft]);
  const load = useCallback(() => {
    const mine = latest.current.next();
    getQuoteCostEstimateAction(quoteId, draftRef.current ?? undefined).then((r) => {
      if (!latest.current.isCurrent(mine)) return;
      if (r.ok && r.data) { setV(r.data); setError(null); } else setError(r.error ?? "The cost estimate could not be read.");
    });
  }, [quoteId]);
  useEffect(load, [load]);
  useEffect(() => {
    if (previewDraft === undefined) return;
    const t = setTimeout(load, 800);
    return () => clearTimeout(t);
  }, [previewDraft, load]);
  const run = async (fn: () => Promise<{ ok: boolean; error?: string }>, done: string) => {
    setBusy(true); setError(null); setNote(null);
    const r = await fn(); setBusy(false);
    if (!r.ok) { setError(r.error ?? "Failed"); return; }
    setNote(done); setManual(null); load(); reload?.();
  };
  return (
    <CostPanelBody
      v={v} loading={!v && !error} error={error} note={note} busy={busy} manual={manual} unsaved={unsaved}
      onRetry={() => { setError(null); load(); }}
      onCapture={(replace) => run(() => captureLatestCostsAction(quoteId, { replaceSelections: !!replace }), "Supplier prices read from Cin7 (read-only). Select a supplier where asked. The estimator's sign-off, if any, must be given again on the new costs.")}
      onSelect={(sku, s, reason) => run(() => selectSupplierAction(quoteId, sku, s, reason), "Supplier selected and recorded.")}
      onRecalculate={() => run(() => recalculateCostsAction(quoteId), "Costs recalculated under the current exchange rates.")}
      onRecordFx={(c, r, s, a) => run(() => recordFxRateAction(c, r, s, a), "Exchange rate recorded. Recalculate to apply it to this estimate.")}
      onConfirmUnit={(reason) => run(() => confirmUnitBasisAction(quoteId, reason), "Recorded: supplier prices are per stock unit.")}
      onAcceptIncomplete={(reason) => run(() => acceptIncompleteCostsAction(quoteId, reason), "Exception recorded.")}
      onClearManual={(sku) => run(() => clearManualCostEstimateAction(quoteId, sku), "Manual estimate removed.")}
      onStartManual={(sku) => setManual({ sku, rand: "", reason: "" })}
      onManualChange={setManual}
      onSaveManual={() => { if (!manual) return; const [w, f = ""] = manual.rand.trim().split("."); run(() => setManualCostEstimateAction(quoteId, manual.sku, Number(w) * 100 + Number(f.padEnd(2, "0")), manual.reason), "Manual estimate recorded."); }}
    />
  );
}
