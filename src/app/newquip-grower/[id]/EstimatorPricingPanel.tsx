"use client";

import { useCallback, useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Status } from "@/components/ui/Status";
import { formatSast } from "@/lib/approvals/time";
import { cost7, formatCost7, fromMicro, micro, LEGACY_RULE_VERSION, type PricingSubmission, type SkuRow } from "@/newquip/pricing/estimator";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import { applyEstimatorPricingAction, disableEstimatorPricingAction, attestEstimatorRatesAction, getEstimatorPricingAction, recordManualPriceEvidenceAction, verifyEstimatorCostsAction } from "../pricing-actions";
import { fmtCents } from "../fields";

// NQ-008B Phase 2: the ESTIMATOR PRICING WORKSPACE. INTERNAL: it shows supplier costs, rates, freight, markup and margin, so the page mounts it only for an Estimator or
// Manager who may see costs, and the server re-checks every action. It renders what the server computed and does no pricing arithmetic of its own; "Save" records one
// immutable revision (who, when, why) and the existing Rep reconfirmation workflow runs when the customer-facing total moved. A SKU with no supplier cost is shown as NOT
// priced, never as R0. The panel never disappears: it says when it is loading, and shows the reason with a retry when the server refuses.

const rand = (cents: number | null | undefined) => (cents == null ? "Not priced" : fmtCents(cents));
const pct = (v: number | null | undefined) => (v == null ? "n/a" : `${v.toFixed(2)}%`);
const signed = (c: number) => (c === 0 ? fmtCents(0) : `${c > 0 ? "+" : "-"}${fmtCents(Math.abs(c))}`);
const dec = (m: number | null | undefined) => (m == null ? "" : String(fromMicro(m)));
/** A typed supplier cost: the exact E7 value, nothing (empty: leave the cost as it is), or a plain-language reason it cannot be accepted. Never rounds or truncates. */
type CostParse = { kind: "empty" } | { kind: "ok"; value: number } | { kind: "bad"; message: string };
function parseCost(text: string): CostParse {
  const t = text.trim();
  if (t === "") return { kind: "empty" };
  try { return { kind: "ok", value: cost7(t) }; } catch (e) {
    if (/^\d+\.\d{8,}$/.test(t)) return { kind: "bad", message: "At most 7 decimal places are allowed (Cin7 supplies up to 7). Nothing was rounded: shorten or correct the value. The previous value is kept." };
    if (e instanceof Error && /too large/.test(e.message)) return { kind: "bad", message: "That cost is too large. The previous value is kept." };
    return { kind: "bad", message: "Enter the cost as a plain number such as 6.5454755 (digits and one decimal point, no commas or units). The previous value is kept." };
  }
}
const toMicro = (s: string): number | null => { try { return s.trim() === "" ? null : micro(s.trim()); } catch { return null; } };
const toCents = (s: string): number | null => { const n = Number(s.replace(/\s/g, "").replace(",", ".")); return s.trim() !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null; };

type Draft = PricingSubmission;
const blankSku = (): Draft["skus"][string] => ({ supplierId: null, supplierName: "", currency: "ZAR", nativeUnitCostE7: 0, source: "", freight: { factorMicro: 1_000_000, source: "" } });

export function EstimatorPricingPanel({ quoteId, reload, unsaved }: { quoteId: string; reload?: () => void; unsaved?: boolean }) {
  const [b, setB] = useState<WorkspaceBundle | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [clears, setClears] = useState<Record<string, number>>({});
  const [evidence, setEvidence] = useState("");
  const [pickedRates, setPickedRates] = useState<string[]>([]);
  const [rateEvidence, setRateEvidence] = useState("");
  const [notes, setNotes] = useState<Record<string, { note: string; reference: string }>>({});

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
  // Exchange-rate rows appear as soon as a SKU is in a foreign currency (not only after a save).
  const foreign = [...new Set([...Object.values(draft.skus).map((s) => s?.currency ?? "").filter((c) => /^[A-Z]{3}$/.test(c) && c !== "ZAR"), ...v.currencies.map((c) => c.currency)])].sort();
  const rateOf = (c: string) => v.rates.find((x) => x.currency === c);
  const verifiable = new Set(b.verification.verifiableSkus);

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
  async function verify() {
    setBusy(true); setErrors([]); setNote(null);
    const r = await verifyEstimatorCostsAction(quoteId, picked.map((sku) => ({ sku, costHash: v.rows.find((r) => r.sku === sku)?.costHash ?? "" })), evidence);
    setBusy(false);
    if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not verify."]); return; }
    setNote(`Recorded as revision ${r.data!.seq}: ${r.data!.verified} supplier cost${r.data!.verified === 1 ? "" : "s"} independently verified. No price changed; the Estimator sign-off (if any) was withdrawn.`);
    setPicked([]); setEvidence(""); load(); reload?.();
  }
  async function attest() {
    setBusy(true); setErrors([]); setNote(null);
    const r = await attestEstimatorRatesAction(quoteId, pickedRates.map((currency) => ({ currency, rateHash: v.currencies.find((c) => c.currency === currency)?.forwardCover?.rateHash ?? "" })), rateEvidence);
    setBusy(false);
    if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not attest."]); return; }
    setNote(`Recorded as revision ${r.data!.seq}: ${r.data!.attested} forward-cover rate${r.data!.attested === 1 ? "" : "s"} independently attested. No price changed; the Estimator sign-off (if any) was withdrawn.`);
    setPickedRates([]); setRateEvidence(""); load(); reload?.();
  }
  async function saveEvidence() {
    const items = Object.entries(notes).filter(([, n]) => n.note.trim().length > 0).map(([itemKey, n]) => ({ itemKey, note: n.note, ...(n.reference.trim() ? { reference: n.reference } : {}) }));
    setBusy(true); setErrors([]); setNote(null);
    const r = await recordManualPriceEvidenceAction(quoteId, items);
    setBusy(false);
    if (!r.ok) { setErrors(r.errors?.length ? r.errors : [r.error ?? "Could not record the evidence."]); return; }
    setNote(`Recorded as revision ${r.data!.seq}: pricing evidence for ${r.data!.recorded} item${r.data!.recorded === 1 ? "" : "s"}. No price changed; the Estimator sign-off (if any) was withdrawn.`);
    setNotes({}); load(); reload?.();
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
        <div><dt className="text-xs text-slate-700">Supplier costs independently verified</dt><dd className="tabular-nums font-semibold" data-testid="sum-verified">{v.costs.verified} of {v.costs.required}</dd></div>
        <div className="sm:col-span-2"><dt className="text-xs text-slate-700">Price completeness</dt><dd data-testid="sum-complete">{v.totals.priceComplete ? "Every line has a price" : "Some lines are NOT priced: there is no project total yet"}</dd></div>
      </dl>
      <p className="text-xs text-slate-700">Margin is a share of the selling price; markup is a share of the cost. They are different numbers. Lines the Estimator prices by design (M75, penning, manual prices) carry no cost and are outside both.</p>

      {v.attention.length > 0 && (
        <Alert tone="warning"><div data-testid="pricing-attention"><b>Needs attention before this can be final.</b><ul className="mt-1 list-disc pl-5">{v.attention.slice(0, 12).map((t) => <li key={t}>{t}</li>)}</ul>{v.attention.length > 12 && <p>…and {v.attention.length - 12} more.</p>}<p className="mt-1">Unverified supplier costs support an indicative price only: they allow the Rep&apos;s handoff but block Estimator sign-off and Manager approval. The incomplete-costing exception does not cover them.</p></div></Alert>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[1100px] text-left text-sm" data-testid="pricing-table">
          <thead><tr className="text-xs text-slate-700">{["SKU / used by", "Qty", "Supplier", "Cur", "Supplier cost", "Source", "Cost verification", "Rate used", "Freight ×", "Landed / unit", "Unit price", "Line total", "Margin / markup"].map((h) => <th key={h} className="px-2 py-1 font-medium">{h}</th>)}</tr></thead>
          <tbody>
            {rowsToShow.map((r) => <Row key={`${r.sku}:${clears[r.sku] ?? 0}`} r={r} edit={edit} input={draft.skus[r.sku]} override={draft.skuPriceOverrides[r.sku]} set={set}
              canPick={verifiable.has(r.sku)} picked={picked.includes(r.sku)} onPick={(on) => setPicked((p) => (on ? [...new Set([...p, r.sku])] : p.filter((x) => x !== r.sku)))}
              onClear={() => { set((d) => { delete d.skus[r.sku]; }); setClears((c) => ({ ...c, [r.sku]: (c[r.sku] ?? 0) + 1 })); setPicked((p) => p.filter((x) => x !== r.sku)); }} />)}
          </tbody>
        </table>
      </div>
      {edit && <AddSku onAdd={addSku} />}

      {foreign.length > 0 && (
        <div data-testid="pricing-fx">
          <h4 className="text-sm font-semibold text-slate-900">Exchange rates (rand per 1 unit) and forward cover</h4>
          <p className="text-xs text-slate-700">A spot rate older than {v.rates[0]?.maxAgeHours ?? 24} hours is expired: the lines using it are not priced, and sign-off and approval are blocked until a current rate is saved. Nothing is repriced until you save. A forward-cover rate needs its contract reference and validity dates and is used only inside them.</p>
          <ul className="mt-1 space-y-2">
            {foreign.map((cur) => {
              const c = v.currencies.find((x) => x.currency === cur); const rt = rateOf(cur);
              const spot = draft.fxQuotes[cur]; const fc = draft.forwardCover[cur];
              return (
                <li key={cur} className="rounded-md border border-slate-200 p-2" data-testid={`fx-${cur}`}>
                  <div className="flex flex-wrap items-end gap-2">
                    <b className="w-10">{cur}</b>
                    <Input label={`${cur} spot rate`} disabled={!edit} defaultValue={dec(spot?.rateMicro)} onBlur={(e) => { const m = toMicro(e.target.value); if (m === null) return; set((d) => { d.fxQuotes[cur] = { rateMicro: m, source: d.fxQuotes[cur]?.source ?? "", asOf: new Date().toISOString() }; }); }} />
                    <Input label={`${cur} rate source`} disabled={!edit} defaultValue={spot?.source ?? ""} onBlur={(e) => set((d) => { if (d.fxQuotes[cur]) d.fxQuotes[cur]!.source = e.target.value; })} />
                    <Input label={`${cur} forward-cover rate`} disabled={!edit} defaultValue={dec(fc?.rateMicro)} placeholder="none" onBlur={(e) => { const m = toMicro(e.target.value); set((d) => { if (e.target.value.trim() === "") delete d.forwardCover[cur]; else if (m !== null) d.forwardCover[cur] = { rateMicro: m, coverDays: d.forwardCover[cur]?.coverDays ?? 90, reason: d.forwardCover[cur]?.reason ?? "", reference: d.forwardCover[cur]?.reference, validFrom: d.forwardCover[cur]?.validFrom, validUntil: d.forwardCover[cur]?.validUntil }; }); }} />
                    {fc && <>
                      <Input label={`${cur} cover days`} disabled={!edit} className="w-20" defaultValue={String(fc.coverDays)} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.coverDays = Math.round(Number(e.target.value)) || 0; })} />
                      <Input label={`${cur} contract reference`} disabled={!edit} defaultValue={fc.reference ?? ""} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.reference = e.target.value; })} />
                      <Input label={`${cur} forward-cover valid from`} placeholder="YYYY-MM-DD" disabled={!edit} className="w-32" defaultValue={fc.validFrom ?? ""} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.validFrom = e.target.value.trim() || undefined; })} />
                      <Input label={`${cur} forward-cover valid until`} placeholder="YYYY-MM-DD" disabled={!edit} className="w-32" defaultValue={fc.validUntil ?? ""} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.validUntil = e.target.value.trim() || undefined; })} />
                      <Input label={`${cur} forward-cover reason`} disabled={!edit} defaultValue={fc.reason} onBlur={(e) => set((d) => { if (d.forwardCover[cur]) d.forwardCover[cur]!.reason = e.target.value; })} />
                    </>}
                  </div>
                  <p className="mt-1 text-xs text-slate-700" data-testid={`fx-note-${cur}`}>
                    {c?.spot ? `Spot recorded ${formatSast(c.spot.asOf)}${rt?.spotAgeHours != null ? ` (${rt.spotAgeHours} h ago)` : ""}.` : "No spot rate recorded yet: lines in this currency are not priced."}
                    {rt?.spotExpired ? " EXPIRED: record a current rate." : ""}
                    {c?.forwardCover ? ` Forward cover in force: ${c.forwardCover.coverDays} days${c.forwardCover.reference ? `, contract ${c.forwardCover.reference}` : ""}${c.forwardCover.validUntil ? `, valid until ${c.forwardCover.validUntil}` : ""}; set by ${c.forwardCover.by}, ${formatSast(c.forwardCover.at)}.` : ""}
                    {rt?.forwardExpired ? " The forward-cover rate has EXPIRED." : ""}
                  </p>
                  {c?.forwardCover && (
                    <p className="mt-1 text-xs text-slate-800" data-testid={`rate-state-${cur}`} data-rate-state={c.forwardCover.state}>
                      <Status tone={c.forwardCover.state === "attested" ? "success" : "warning"}>{c.forwardCover.state === "attested" ? "Attested" : c.forwardCover.state === "attestation_outdated" ? "Changed since attested" : c.forwardCover.state === "self_attested" ? "Not independent" : c.forwardCover.state === "undocumented" ? "Needs reference / dates" : "Not attested"}</Status>{" "}
                      {c.forwardCover.state === "attested" && c.forwardCover.review ? `Independently attested by ${c.forwardCover.review.by}, ${formatSast(c.forwardCover.review.at)}: ${c.forwardCover.review.evidence}` : `Not final: ${c.forwardCover.stateText}.`}
                    </p>
                  )}
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

      {v.enabled && v.manualEvidence.length > 0 && (
        <div className="space-y-2 rounded-md border border-slate-300 p-2" data-testid="evidence-block">
          <h4 className="text-sm font-semibold text-slate-900">Pricing evidence for manual items</h4>
          <p className="text-xs text-slate-700">These items are priced by the Estimator and have no SKU behind them (for example the M75 system, LED lighting, penning). Record what each price is based on: a note is required before final approval, and it stops applying if the price changes. Recording evidence changes no price.</p>
          <ul className="space-y-2">
            {v.manualEvidence.map((m) => (
              <li key={m.itemKey} className="rounded-md border border-slate-200 p-2" data-testid="evidence-item" data-item={m.itemKey} data-evidence-state={m.state}>
                <div className="flex flex-wrap items-baseline gap-2"><b>{m.label}</b><Status tone={m.state === "recorded" ? "success" : "warning"}>{m.state === "recorded" ? "Evidence recorded" : m.state === "outdated" ? "Price changed since" : "No evidence"}</Status></div>
                {m.note && <p className="mt-1 text-xs text-slate-800" data-testid="evidence-text">{m.note}{m.reference ? ` (ref ${m.reference})` : ""} — {m.by}, {m.at ? formatSast(m.at) : ""}</p>}
                {m.state === "outdated" && <p className="mt-1 text-xs text-slate-900">{m.stateText}.</p>}
                {edit && b.state !== "MANAGER_APPROVED_FINAL" && (
                  <div className="mt-1 flex flex-wrap items-end gap-2">
                    <Input label={`${m.label} evidence note`} className="w-full sm:w-[24rem]" value={notes[m.itemKey]?.note ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [m.itemKey]: { note: e.target.value, reference: n[m.itemKey]?.reference ?? "" } }))} />
                    <Input label={`${m.label} evidence reference (optional)`} className="w-48" value={notes[m.itemKey]?.reference ?? ""} onChange={(e) => setNotes((n) => ({ ...n, [m.itemKey]: { note: n[m.itemKey]?.note ?? "", reference: e.target.value } }))} />
                  </div>
                )}
              </li>
            ))}
          </ul>
          {edit && b.state !== "MANAGER_APPROVED_FINAL" && <Button size="sm" onClick={saveEvidence} disabled={busy || unsaved || !Object.values(notes).some((n) => n.note.trim().length >= 10)} data-testid="evidence-save">Record pricing evidence</Button>}
        </div>
      )}

      {b.rateAttestation.canReview && b.state !== "MANAGER_APPROVED_FINAL" && v.currencies.some((c) => c.forwardCover) && (
        <div className="space-y-2 rounded-md border border-slate-300 p-2" data-testid="attest-block">
          <h4 className="text-sm font-semibold text-slate-900">Independent forward-cover rate attestation</h4>
          <p className="text-xs text-slate-700">You may attest a forward-cover rate you did not enter ({b.rateAttestation.reviewerRoles.join(" or ")}; provisional). Check its contract reference, validity dates and the contract itself, then tick it. Attesting changes no price. Any later change to the rate, contract or dates makes the attestation stop applying.</p>
          <ul className="flex flex-wrap gap-3">{b.rateAttestation.attestableCurrencies.map((cur) => <li key={cur}><label className="flex items-center gap-1"><input type="checkbox" checked={pickedRates.includes(cur)} onChange={(e) => setPickedRates((p) => (e.target.checked ? [...new Set([...p, cur])] : p.filter((x) => x !== cur)))} aria-label={`Attest ${cur} forward-cover rate`} />Attest the {cur} rate</label></li>)}</ul>
          {b.rateAttestation.attestableCurrencies.length === 0 && <p className="text-xs text-slate-800" data-testid="attest-none">There is no forward-cover rate you may attest now (rates you entered yourself need another reviewer).</p>}
          <Input label="Evidence checked (for example the forward-exchange contract number)" value={rateEvidence} onChange={(e) => setRateEvidence(e.target.value)} className="w-full sm:w-[28rem]" />
          <Button size="sm" onClick={attest} disabled={busy || pickedRates.length === 0 || rateEvidence.trim().length < 3} data-testid="attest-save">Attest {pickedRates.length} selected rate{pickedRates.length === 1 ? "" : "s"}</Button>
        </div>
      )}

      {b.verification.canReview && b.state !== "MANAGER_APPROVED_FINAL" && (
        <div className="space-y-2 rounded-md border border-slate-300 p-2" data-testid="verify-block">
          <h4 className="text-sm font-semibold text-slate-900">Independent cost verification</h4>
          <p className="text-xs text-slate-700">You may verify a supplier cost you did not enter ({b.verification.reviewerRoles.join(" or ")}; provisional). Tick the costs you have checked against the evidence. Verifying changes no price and does not touch the customer total. Any later change to a cost makes its verification stop applying.</p>
          <Input label="Evidence checked (for example the supplier quote reference)" value={evidence} onChange={(e) => setEvidence(e.target.value)} className="w-full sm:w-[28rem]" />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={verify} disabled={busy || picked.length === 0 || evidence.trim().length < 3} data-testid="verify-save">Verify {picked.length} selected cost{picked.length === 1 ? "" : "s"}</Button>
            <Button size="sm" variant="secondary" onClick={() => setPicked([...verifiable])} disabled={busy || verifiable.size === 0} data-testid="verify-all">Select all I may verify ({verifiable.size})</Button>
          </div>
        </div>
      )}

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

function Row({ r, edit, input, override, set, canPick, picked, onPick, onClear }: { r: SkuRow; edit: boolean; input: Draft["skus"][string] | undefined; override: Draft["skuPriceOverrides"][string] | undefined; set: (f: (d: Draft) => void) => void; canPick: boolean; picked: boolean; onPick: (on: boolean) => void; onClear: () => void }) {
  const tone = r.status === "priced" ? "success" : "danger";
  const [costError, setCostError] = useState<string | null>(null);
  const upd = (f: (s: Draft["skus"][string]) => void) => set((d) => { d.skus[r.sku] = d.skus[r.sku] ?? blankSku(); f(d.skus[r.sku]); });
  return (
    <>
      <tr className="border-t border-slate-200 align-top" data-testid="pricing-row" data-sku={r.sku} data-status={r.status}>
        <td className="px-2 py-1"><b>{r.sku}</b><div className="text-xs text-slate-700">{r.usedBy.join("; ")}</div><Status tone={tone}>{r.status === "priced" ? "Priced" : r.status === "no_input" ? "No supplier cost: NOT priced" : "NOT priced"}</Status></td>
        <td className="px-2 py-1 tabular-nums">{r.quantity}</td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} supplier`} disabled={!edit} defaultValue={input?.supplierName ?? ""} className="w-32" onBlur={(e) => upd((s) => { s.supplierName = e.target.value; })} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} currency`} disabled={!edit} defaultValue={input?.currency ?? "ZAR"} className="w-16" onBlur={(e) => upd((s) => { s.currency = e.target.value.trim().toUpperCase(); })} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} supplier cost`} disabled={!edit} defaultValue={input?.nativeUnitCostE7 == null ? "" : formatCost7(input.nativeUnitCostE7)} error={costError ?? undefined} className="w-24" onBlur={(e) => { const c = parseCost(e.target.value); if (c.kind === "bad") { setCostError(c.message); return; } setCostError(null); if (c.kind === "ok") upd((s) => { s.nativeUnitCostE7 = c.value; }); }} /></td>
        <td className="px-2 py-1"><Input hideLabel label={`${r.sku} cost source`} disabled={!edit} defaultValue={input?.source ?? ""} className="w-32" onBlur={(e) => upd((s) => { s.source = e.target.value; })} /></td>
        <td className="px-2 py-1 text-xs" data-testid="cost-state" data-cost-state={r.costState}>
          <Status tone={r.costState === "verified" ? "success" : r.costState === "missing" ? "danger" : "warning"}>{r.costState === "verified" ? "Verified" : r.costState === "missing" ? "No cost" : r.costState === "review_outdated" ? "Changed since verified" : r.costState === "self_reviewed" ? "Not independent" : "Unverified"}</Status>
          {r.review && <div>by {r.review.by}, {formatSast(r.review.at)}<br />{r.review.evidence}</div>}
          {r.enteredBy && <div className="text-slate-600">entered by {r.enteredBy}</div>}
          {r.priceBasis === "manual_price" && <div className="text-slate-900">Price is a MANUAL price; its supplier cost still has to be recorded and verified.</div>}
        </td>
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
            {edit && input && <Button size="sm" variant="secondary" onClick={onClear} data-testid="clear-cost">Clear supplier cost</Button>}
            {canPick && <label className="flex items-center gap-1"><input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Verify ${r.sku} cost`} />Verify this cost</label>}
            {r.issues.length > 0 && <span className="text-slate-900" data-testid="row-issues">{r.issues.join(" · ")}</span>}
            <span className="text-slate-700">Quantity changes are made in the quantity overrides, with their own reasons.</span>
          </div>
        </td>
      </tr>
    </>
  );
}
