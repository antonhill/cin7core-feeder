"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { formatSast } from "@/lib/approvals/time";
import { fromMicro, micro, LEGACY_RULE_VERSION, type PricingSubmission, type SkuRow } from "@/newquip/pricing/estimator";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import { applyEstimatorPricingAction, disableEstimatorPricingAction, getEstimatorPricingAction } from "../pricing-actions";
import { fmtCents } from "../fields";

// NQ-008B Phase 2: the ESTIMATOR PRICING WORKSPACE. INTERNAL: it shows supplier costs, rates, freight, markup and margin, so the page mounts it only for an Estimator or
// Manager who may see costs, and the server re-checks every action. It renders what the server computed and does no pricing arithmetic of its own; "Save" records one
// immutable revision (who, when, why) and the existing Rep reconfirmation workflow runs when the customer-facing total moved. A SKU with no supplier cost is shown as NOT
// priced, never as R0. The panel never disappears: it says when it is loading, and shows the reason with a retry when the server refuses.

const rand = (cents: number | null | undefined) => (cents == null ? "Not priced" : fmtCents(cents));
const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${v.toFixed(2)}%`);
const signed = (c: number) => (c === 0 ? fmtCents(0) : `${c > 0 ? "+" : "-"}${fmtCents(Math.abs(c))}`);
const dec = (m: number | null | undefined) => (m == null ? "" : String(fromMicro(m)));
const toMicro = (s: string): number | null => { try { return s.trim() === "" ? null : micro(s.trim()); } catch { return null; } };
const toCents = (s: string): number | null => { const n = Number(s.replace(/\s/g, "").replace(",", ".")); return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };

type Draft = PricingSubmission;
const blankSku = (): Draft["skus"][string] => ({ supplierId: null, supplierName: "", currency: "ZAR", nativeUnitCostMicro: 0, verification: "unverified", source: "", freight: { factorMicro: 1_000_000, source: "" } });

export function EstimatorPricingPanel({ quoteId, reload, unsaved }: { quoteId: string; reload?: () => void; unsaved?: boolean }) {
  const [b, setB] = useState<WorkspaceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void getEstimatorPricingAction(quoteId).then((r) => {
      if (r.ok && r.data) { setB(r.data); setDraft(r.data.current ?? { ruleVersionId: LEGACY_RULE_VERSION.id, skus: {}, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null }); }
      else setError(r.error ?? "Supplier pricing could not be loaded.");
    });
  }, [quoteId]);
  useEffect(() => { load(); }, [load]);

  if (error) return (<Panel><PanelTitle>Supplier pricing</PanelTitle><Alert tone="warning"><span data-testid="pricing-error">{error}</span></Alert><Button variant="secondary" size="sm" onClick={load}>Try again</Button></Panel>);
  if (!b || !draft) return (<Panel><PanelTitle>Supplier pricing</PanelTitle><p className="text-sm text-slate-800" data-testid="pricing-loading">Loading supplier pricing…</p></Panel>);

  const v = b.view;
  const edit = b.canEdit;
  const set = (f: (d: Draft) => void) => setDraft((d) => { const n = structuredClone(d!); f(n); return n; });
  const rowsToShow = v.rows;

  async function save() {
    if (!draft) return;
    setBusy(true); setErrors([]); setNote(null);
    const r = await applyEstimatorPricingAction(quoteId, draft, reason);
    setBusy(false);
    if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not save."]); return; }
    const c = r.data?.confirmation;
    setNote(c?.returnedToRep ? "Saved as revision " + r.data!.seq + ". The customer total changed, so the Rep's confirmation was withdrawn and the quotation is back with the Rep to reconfirm." : `Saved as revision ${r.data!.seq}. The customer total did not change; the Estimator sign-off (if any) was withdrawn because the content changed.`);
    setReason(""); load(); reload?.();
  }
  async function off() {
    setBusy(true); setErrors([]); setNote(null);
    const r = await disableEstimatorPricingAction(quoteId, reason);
    setBusy(false);
    if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not switch off."]); return; }
    setNote("Supplier pricing switched off: this quotation is priced from the POC workbook again."); setReason(""); load(); reload?.();
  }

  const addSku = (sku: string) => { const s = sku.trim(); if (s) set((d) => { d.skus[s] = d.skus[s] ?? blankSku(); }); };

  return (
    <Panel className="space-y-4"><div className="space-y-4" data-testid="estimator-pricing-panel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <PanelTitle>Supplier pricing (Estimator)</PanelTitle>
        <Status tone={v.enabled ? (v.finality.final ? "success" : "warning") : "neutral"}>{v.enabled ? (v.finality.final ? `On · revision ${v.revision}` : `On · indicative only · revision ${v.revision}`) : "Off: priced from the POC workbook"}</Status>
      </div>
      {unsaved && <Alert tone="warning">This workspace reflects the SAVED quotation. Save or discard your unsaved edits first.</Alert>}
      {!v.available && <Alert tone="info">Supplier pricing applies to project quotations only.</Alert>}
      {!v.enabled && v.available && <Alert tone="info">Supplier pricing is off, so this quotation uses its existing POC prices and nothing changes. Enter the supplier costs below and save to switch it on: the quotation is then priced from supplier cost × exchange rate × freight, plus the project markup.</Alert>}
      {b.state === "MANAGER_APPROVED_FINAL" && <Alert tone="info">Approved: the pricing is frozen with the baseline and cannot be changed.</Alert>}

      <dl className="grid gap-3 text-sm sm:grid-cols-4" data-testid="pricing-summary">
        <div><dt className="text-xs text-slate-700">Rep-confirmed indicative total</dt><dd className="tabular-nums font-semibold" data-testid="sum-original">{v.indicative.originalTotalCents == null ? "No handoff yet" : fmtCents(v.indicative.originalTotalCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Current total</dt><dd className="tabular-nums font-semibold" data-testid="sum-current">{v.indicative.currentTotalCents == null ? "Not priced yet" : fmtCents(v.indicative.currentTotalCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Difference</dt><dd className="tabular-nums font-semibold" data-testid="sum-delta">{v.indicative.deltaCents == null ? "n/a" : signed(v.indicative.deltaCents)}</dd></div>
        <div><dt className="text-xs text-slate-700">Project markup</dt><dd className="tabular-nums font-semibold" data-testid="sum-markup-rule">{v.markup.bps == null ? "Rule version default" : `${v.markup.bps / 100}% (changed)`}</dd></div>
        <div><dt className="text-xs text-slate-700">Gross margin (costed lines)</dt><dd className="tabular-nums font-semibold" data-testid="sum-margin">{pct(v.totals.margin?.marginPct)}</dd></div>
        <div><dt className="text-xs text-slate-700">Markup on cost (costed lines)</dt><dd className="tabular-nums font-semibold" data-testid="sum-markup">{pct(v.totals.margin?.markupPct)}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs text-slate-700">Pricing completeness</dt><dd data-testid="sum-complete">{v.totals.priceComplete ? "Every line has a price" : "Some lines are NOT priced: there is no project total yet"}</dd></div>
      </dl>
      <p className="text-xs text-slate-700">Margin is a share of the selling price; markup is a share of the cost. They are different numbers. Lines the Estimator prices by design (M75, penning, manual prices) carry no cost and are outside both.</p>

      {v.attention.length > 0 && (
        <Alert tone="warning"><div data-testid="pricing-attention"><b>Needs attention before this can be final.</b><ul className="mt-1 list-disc pl-5">{v.attention.slice(0, 12).map((t) => <li key={t}>{t}</li>)}</ul>{v.attention.length > 12 && <p>…and {v.attention.length - 12} more.</p>}<p className="mt-1">Unverified supplier costs support an indicative price only: they allow the Rep&apos;s handoff but block Estimator sign-off and Manager approval. The incomplete-costing exception does not cover them.</p></div></Alert>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-sm" data-testid="pricing-table">
          <thead><tr className="text-xs text-slate-700">{["SKU / used by", "Qty", "Supplier", "Cur", "Supplier cost", "Source", "Verified", "Rate used", "Freight ×", "Landed / unit", "Unit price", "Line total", "Margin / markup"].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rowsToShow.map((r) => <Row key={r.sku} r={r} edit={edit} input={draft.skus[r.sku]} override={draft.skuPriceOverrides[r.sku]} set={set} />)}
          </tbody>
        </table>
      </div>
      {edit && <AddSku onAdd={addSku} />}

      {v.currencies.length > 0 && (
        <div data-testid="pricing-fx">
          <h4 className="text-sm font-semibold text-slate-900">Exchange rates (rand per 1 unit) and forward cover</h4>
          <ul className="mt-1 space-y-2">
            {v.currencies.map((c) => {
              const spot = draft.fxQuotes[c.currency]; const fc = draft.forwardCover[c.currency];
              return (
                <li key={c.currency} className="rounded-md border border-slate-200 p-2" data-testid={`fx-${c.currency}`}>
                  <div className="flex flex-wrap items-end gap-2">
                    <b className="w-10">{c.currency}</b>
                    <Input label={`${c.currency} spot rate`} disabled={!edit} defaultValue={dec(spot?.rateMicro)} onBlur={(e) => { const m = toMicro(e.target.value); set((d) => { d.fxQuotes[c.currency] = { rateMicro: m ?? 0, source: d.fxQuotes[c.currency]?.source ?? "", asOf: d.fxQuotes[c.currency]?.asOf ?? new Date().toISOString() }; }); }} />
                    <Input label={`${c.currency} rate source`} disabled={!edit} defaultValue={spot?.source ?? ""} onBlur={(e) => set((d) => { if (d.fxQuotes[c.currency]) d.fxQuotes[c.currency]!.source = e.target.value; })} />
                    <Input label={`${c.currency} forward-cover rate`} disabled={!edit} defaultValue={dec(fc?.rateMicro)} placeholder="none" onBlur={(e) => { const m = toMicro(e.target.value); set((d) => { if (m === null) delete d.forwardCover[c.currency]; else d.forwardCover[c.currency] = { rateMicro: m, coverDays: d.forwardCover[c.currency]?.coverDays ?? 90, reason: d.forwardCover[c.currency]?.reason ?? "", reference: d.forwardCover[c.currency]?.reference }; }); }} />
                    {fc && <>
                      <Input label={`${c.currency} cover days`} disabled={!edit} className="w-20" defaultValue={String(fc.coverDays)} onBlur={(e) => set((d) => { if (d.forwardCover[c.currency]) d.forwardCover[c.currency]!.coverDays = Math.round(Number(e.target.value)) || 0; })} />
                      <Input label={`${c.currency} contract reference`} disabled={!edit} defaultValue={fc.reference ?? ""} onBlur={(e) => set((d) => { if (d.forwardCover[c.currency]) d.forwardCover[c.currency]!.reference = e.target.value; })} />
                      <Input label={`${c.currency} forward-cover reason`} disabled={!edit} defaultValue={fc.reason} onBlur={(e) => set((d) => { if (d.forwardCover[c.currency]) d.forwardCover[c.currency]!.reason = e.target.value; })} />
                    </>}
                  </div>
                  <p className="mt-1 text-xs text-slate-700">{c.spot ? `Spot as of ${formatSast(c.spot.asOf)}.` : "No spot rate recorded: lines in this currency are not priced."}{c.forwardCover ? ` Forward cover in force (${c.forwardCover.coverDays} days): set by ${c.forwardCover.by}, ${formatSast(c.forwardCover.at)}.` : ""}</p>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-2" data-testid="pricing-project">
        <div className="rounded-md border border-slate-200 p-2">
          <h4 className="text-sm font-semibold text-slate-900">Project markup on landed cost</h4>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <Input label="Project markup percent" disabled={!edit} className="w-24" defaultValue={draft.projectMarkup ? String(draft.projectMarkup.markupBps / 100) : ""} placeholder="rule default" onBlur={(e) => set((d) => { const n = Number(e.target.value); if (e.target.value.trim() === "") d.projectMarkup = null; else d.projectMarkup = { markupBps: Math.round(n * 100), reason: d.projectMarkup?.reason ?? "" }; })} />
            <Input label="Project markup reason" disabled={!edit} defaultValue={draft.projectMarkup?.reason ?? ""} onBlur={(e) => set((d) => { if (d.projectMarkup) d.projectMarkup.reason = e.target.value; })} />
          </div>
          <p className="mt-1 text-xs text-slate-700">Changes every line&apos;s price (it is pricing). Leave blank to use the rule version&apos;s markup.</p>
        </div>
        <div className="rounded-md border border-slate-200 p-2">
          <h4 className="text-sm font-semibold text-slate-900">Target project price (internal only)</h4>
          <div className="mt-1 flex flex-wrap items-end gap-2">
            <Input label="Target project price" disabled={!edit} className="w-36" defaultValue={draft.targetAdjustment ? String(draft.targetAdjustment.targetTotalCents / 100) : ""} onBlur={(e) => set((d) => { const c = toCents(e.target.value); if (e.target.value.trim() === "") d.targetAdjustment = null; else d.targetAdjustment = { targetTotalCents: c ?? 0, reason: d.targetAdjustment?.reason ?? "" }; })} />
            <Input label="Target price reason" disabled={!edit} defaultValue={draft.targetAdjustment?.reason ?? ""} onBlur={(e) => set((d) => { if (d.targetAdjustment) d.targetAdjustment.reason = e.target.value; })} />
          </div>
          {v.adjustment ? (
            <p className="mt-1 text-sm" data-testid="adjustment-view">Would adjust the quotation by <b>{signed(v.adjustment.wouldAdjustByCents)}</b> (from {fmtCents(v.adjustment.currentTotalCents)} to {fmtCents(v.adjustment.targetTotalCents)}); margin at the target {pct(v.adjustment.atTarget?.marginPct)}, markup {pct(v.adjustment.atTarget?.markupPct)}. <b>Not applied to the customer quotation</b>: how it would appear to the customer is undecided.</p>
          ) : <p className="mt-1 text-xs text-slate-700">Never applied to the customer quotation: how a project-level adjustment appears to the customer is not yet decided by NewQuip.</p>}
        </div>
      </div>

      {edit && (
        <div className="space-y-2 border-t border-slate-200 pt-3">
          {errors.length > 0 && <Alert tone="danger"><ul data-testid="pricing-errors" className="list-disc pl-5">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
          {note && <Alert tone="info"><span data-testid="pricing-note">{note}</span></Alert>}
          <Input label="Reason for this pricing revision" value={reason} onChange={(e) => setReason(e.target.value)} className="w-full sm:w-[28rem]" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={save} disabled={busy || unsaved || reason.trim().length < 3} loading={busy} data-testid="pricing-save">{v.enabled ? "Save pricing revision" : "Switch on supplier pricing"}</Button>
            {v.enabled && <Button size="sm" variant="secondary" onClick={off} disabled={busy || unsaved || reason.trim().length < 3} data-testid="pricing-off">Switch off (back to POC prices)</Button>}
          </div>
          <p className="text-xs text-slate-700">Saving withdraws any Estimator sign-off. If the customer-facing total changes, the Rep&apos;s confirmation is withdrawn and the quotation returns to the Rep to reconfirm; the amount the Rep confirmed at handoff is kept as it was.</p>
        </div>
      )}

      <details>
        <summary className="cursor-pointer text-sm font-semibold text-slate-900" data-testid="pricing-history-summary">Revision history ({b.revisions.length})</summary>
        <ol className="mt-2 space-y-2" data-testid="pricing-history">
          {b.revisions.length === 0 && <li className="text-sm text-slate-700">No revisions yet.</li>}
          {[...b.revisions].reverse().map((r) => (
            <li key={r.id} className="rounded-md border border-slate-200 p-2 text-sm">
              <div><b>Revision {r.seq}</b> · {r.kind.toLowerCase()} · rules {r.ruleVersion} · {r.changedBy}, {formatSast(r.at)}</div>
              <div>Why: {r.reason}</div>
              <ul className="mt-1 list-disc pl-5 text-xs text-slate-800">{r.changes.slice(0, 8).map((c) => <li key={c.path}>{c.path}: {JSON.stringify(c.previous)} → {JSON.stringify(c.new)}</li>)}{r.changes.length > 8 && <li>…and {r.changes.length - 8} more</li>}</ul>
            </li>
          ))}
        </ol>
      </details>
    </div></Panel>
  );
}

function AddSku({ onAdd }: { onAdd: (sku: string) => void }) {
  const [sku, setSku] = useState("");
  return (
    <div className="flex items-end gap-2">
      <Input label="SKU to add" value={sku} onChange={(e) => setSku(e.target.value)} className="w-56" />
      <Button size="sm" variant="secondary" onClick={() => { onAdd(sku); setSku(""); }} disabled={!sku.trim()}>Add</Button>
    </div>
  );
}

function Row({ r, edit, input, override, set }: { r: SkuRow; edit: boolean; input: Draft["skus"][string] | undefined; override: Draft["skuPriceOverrides"][string] | undefined; set: (f: (d: Draft) => void) => void }) {
  const tone = r.status === "priced" ? "success" : "danger";
  const upd = (f: (s: Draft["skus"][string]) => void) => set((d) => { d.skus[r.sku] = d.skus[r.sku] ?? blankSku(); f(d.skus[r.sku]); });
  return (
    <>
      <tr className="border-t border-slate-200 align-top" data-testid="pricing-row" data-sku={r.sku} data-status={r.status}>
        <td className="px-2 py-1"><b>{r.sku}</b><div className="text-xs text-slate-700">{r.usedBy.join("; ")}</div><Status tone={tone}>{r.status === "priced" ? "Priced" : r.status === "no_input" ? "No supplier cost: NOT priced" : "NOT priced"}</Status></td>
        <td className="px-2 py-1 tabular-nums">{r.quantity}</td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} supplier`} disabled={!edit} defaultValue={input?.supplierName ?? ""} className="w-32" onBlur={(e) => upd((s) => { s.supplierName = e.target.value; })} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} currency`} disabled={!edit} defaultValue={input?.currency ?? "ZAR"} className="w-16" onBlur={(e) => upd((s) => { s.currency = e.target.value.trim().toUpperCase(); })} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} supplier cost`} disabled={!edit} defaultValue={dec(input?.nativeUnitCostMicro)} className="w-24" onBlur={(e) => upd((s) => { s.nativeUnitCostMicro = toMicro(e.target.value) ?? 0; })} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} cost source`} disabled={!edit} defaultValue={input?.source ?? ""} className="w-32" onBlur={(e) => upd((s) => { s.source = e.target.value; })} /></td>
        <td className="px-2 py-1"><select aria-label={`${r.sku} verification`} disabled={!edit} defaultValue={input?.verification ?? "unverified"} className="rounded border border-slate-300 px-1 py-1 text-sm" onChange={(e) => upd((s) => { s.verification = e.target.value as "verified" | "unverified"; })}><option value="unverified">Unverified</option><option value="verified">Verified</option></select></td>
        <td className="px-2 py-1 text-xs">{r.rate ? `${r.rate.kind === "forward_cover" ? `Forward cover (${r.rate.coverDays} d)` : r.rate.kind === "spot" ? "Spot" : "Rand"} ${fromMicro(r.rate.rateMicro)}` : "n/a"}</td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} freight factor`} disabled={!edit} defaultValue={dec(input?.freight?.factorMicro)} className="w-16" onBlur={(e) => upd((s) => { s.freight = { factorMicro: toMicro(e.target.value) ?? 1_000_000, addOnCents: s.freight?.addOnCents, source: s.freight?.source || "Estimator" }; })} /></td>
        <td className="px-2 py-1 tabular-nums">{rand(r.unitLandedCostCents)}</td>
        <td className="px-2 py-1 tabular-nums">{rand(r.unitPriceCents)}{r.priceOrigin === "item_override" && <div className="text-xs text-slate-700">override</div>}</td>
        <td className="px-2 py-1 tabular-nums">{rand(r.lineRevenueCents)}</td>
        <td className="px-2 py-1 text-xs tabular-nums">{r.margin ? `${pct(r.margin.marginPct)} / ${pct(r.margin.markupPct)}` : "n/a"}</td>
      </tr>
      <tr className="text-xs" data-testid="pricing-row-extra">
        <td colSpan={13} className="px-2 pb-2">
          <div className="flex flex-wrap items-end gap-2">
            <Input label={`${r.sku} price override per unit (R)`} disabled={!edit} className="w-28" defaultValue={override ? String(override.unitPriceCents / 100) : ""} placeholder="none" onBlur={(e) => set((d) => { if (e.target.value.trim() === "") delete d.skuPriceOverrides[r.sku]; else d.skuPriceOverrides[r.sku] = { unitPriceCents: toCents(e.target.value) ?? 0, reason: d.skuPriceOverrides[r.sku]?.reason ?? "" }; })} />
            {override && <Input label={`${r.sku} override reason (required)`} disabled={!edit} className="w-64" defaultValue={override.reason} onBlur={(e) => set((d) => { if (d.skuPriceOverrides[r.sku]) d.skuPriceOverrides[r.sku]!.reason = e.target.value; })} />}
            {r.priceOverride && <span>Override set by {r.priceOverride.by}, {formatSast(r.priceOverride.at)}</span>}
            {r.issues.length > 0 && <span className="text-slate-900" data-testid="row-issues">{r.issues.join(" · ")}</span>}
            <span className="text-slate-700">Quantity changes are made in the quantity overrides, with their own reasons.</span>
          </div>
        </td>
      </tr>
    </>
  );
}
