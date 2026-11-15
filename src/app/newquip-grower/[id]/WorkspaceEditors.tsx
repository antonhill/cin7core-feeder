"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { WorkspaceBundle } from "@/lib/newquip-quotes/pricing-service";
import { manualSelectionSkusFor, packageFor } from "@/newquip/grower/commercial";
import type { GrowerItemKey } from "@/newquip/grower/types";
import { decodeManualReason, encodeManualReason, manualPriceComplete, money } from "@/newquip/quote/estimator-workspace";
import { applyEditor, editorFrom, editorProblems, fxContext, isForeign, parseCostText, previewLine, type SkuEditor } from "@/newquip/quote/workspace-submission";
import { ProductMappingPicker } from "./ProductMappingPicker";

// The focused editors of the Estimator workspace. One editor per product. They keep what was typed in local state until a save succeeds (a refused or conflicting save never clears a field),
// report whether anything typed is unsaved so the workspace can warn before leaving, and show the model's own calculation of what the typed values would price at.

const areaCls = "w-full rounded-lg border-[1.5px] border-slate-500 bg-white px-3 py-2 text-[15px] text-slate-900";
const Section = ({ title, hint, children, testId }: { title: string; hint?: string; children: ReactNode; testId?: string }) => (
  <section className="rounded-xl border border-slate-200 bg-white p-5" data-testid={testId}><h3 className="mb-3 text-[15px] font-bold text-slate-900">{title}{hint && <span className="ml-2 font-normal text-slate-600">· {hint}</span>}</h3>{children}</section>
);
const Hint = ({ children }: { children: ReactNode }) => <p className="mt-1.5 text-[12.5px] text-slate-700">{children}</p>;
export type SaveResult = { ok: boolean; errors?: string[] };

export function Rail({ tasks, activeId, onSelect }: { tasks: Array<{ id: string; n: number; label: string }>; activeId: string; onSelect: (id: string) => void }) {
  return (
    <nav aria-label="Tasks" className="flex min-w-0 flex-col gap-1.5 sm:w-[210px] sm:shrink-0">
      <p className="mb-1 text-xs font-bold tracking-widest text-slate-600">TASKS</p>
      {tasks.map((t) => <button key={t.id} type="button" onClick={() => onSelect(t.id)} aria-current={t.id === activeId ? "true" : undefined} className={`min-h-11 rounded-lg px-3 text-left text-sm ${t.id === activeId ? "border-[1.5px] border-blue-700 bg-sky-50 font-semibold" : "border border-transparent hover:bg-slate-100"}`}>{t.n} &nbsp;{t.label}</button>)}
    </nav>
  );
}

/** One product's supplier cost, currency, FX, freight and price. Used for a single SKU line, a package component, and the door once chosen. */
export function SkuCostForm({ sku, label, quantity, bundle, canEdit, save, onDirty, onSaved, saveLabel = "Save cost", testId = "sku-form" }: {
  sku: string; label: string; quantity: number; bundle: WorkspaceBundle; canEdit: boolean;
  save: (sku: string, e: SkuEditor) => Promise<SaveResult>; onDirty: (dirty: boolean) => void; onSaved?: () => void; saveLabel?: string; testId?: string;
}) {
  const [initial, setInitial] = useState<SkuEditor>(() => editorFrom(bundle.current, sku));
  const [ed, setEd] = useState<SkuEditor>(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = JSON.stringify(ed) !== JSON.stringify(initial);
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const fx = fxContext(bundle.current, sku, ed.currency);
  const problems = editorProblems(ed, fx);
  const nowIso = useMemo(() => new Date().toISOString(), [ed]); // eslint-disable-line react-hooks/exhaustive-deps
  const sub = useMemo(() => (problems.length === 0 ? applyEditor(bundle.current, sku, ed, nowIso) : null), [bundle.current, sku, ed, nowIso]); // eslint-disable-line react-hooks/exhaustive-deps
  const pv = useMemo(() => previewLine(sub, sku, quantity, nowIso), [sub, sku, quantity, nowIso]);
  const row = bundle.view.rows.find((r) => r.sku === sku);
  const set = (f: (e: SkuEditor) => void) => { setSaved(null); setEd((p) => { const n = structuredClone(p); f(n); return n; }); };
  const foreign = isForeign(ed.currency);
  const disabled = !canEdit || busy;
  async function doSave() {
    if (problems.length > 0 || busy) return;
    setBusy(true); setErrors([]); setSaved(null);
    try {
      const r = await save(sku, ed);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : ["Could not save. Nothing you typed was lost."]); return; }
      setInitial(structuredClone(ed)); setSaved("Saved."); onDirty(false); onSaved?.();
    } catch { setErrors(["That did not complete (the connection or the server failed). Nothing you typed was lost."]); } finally { setBusy(false); }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start" data-testid={testId}>
      <div className="flex min-w-0 flex-[1_1_28rem] flex-col gap-4">
        <Section title="Supplier cost" hint={`${label} · ${sku}`}>
          <div className="flex flex-wrap gap-4">
            <div className="min-w-[12rem] flex-[2_1_14rem]"><Input label="Supplier" value={ed.supplierName} disabled={disabled} onChange={(e) => set((d) => { d.supplierName = e.target.value; })} /></div>
            <div className="w-28"><Input label="Currency" value={ed.currency} maxLength={3} disabled={disabled} onChange={(e) => set((d) => { d.currency = e.target.value.toUpperCase(); })} /></div>
            <div className="min-w-[10rem] flex-[1_1_11rem]"><Input label="Unit cost (up to 7 decimals)" inputMode="decimal" className="tabular-nums" value={ed.costText} disabled={disabled} onChange={(e) => set((d) => { d.costText = e.target.value; })} error={parseProblem(ed.costText)} /></div>
          </div>
          <div className="mt-4"><Input label="Where this cost comes from" value={ed.source} disabled={disabled} onChange={(e) => set((d) => { d.source = e.target.value; })} helperText="Required. Shown to the Manager who verifies it." /></div>
        </Section>
        {foreign && (
          <Section title="Exchange rate" hint={`${ed.currency} to rand`}>
            <p className="mb-3 rounded-lg bg-sky-50 px-3 py-2 text-[13px] text-sky-950" data-testid="fx-shared-note">This rate applies to every {ed.currency} product on this quotation{fx.others.length > 0 ? <>: also {fx.others.join(", ")}. {fx.hasForward ? "A forward-cover contract is in force for them." : ""}</> : <>. No other product uses {ed.currency} yet.</>}</p>
            <div role="radiogroup" aria-label="Exchange rate" className="flex flex-wrap gap-3">
              <label className={`flex min-w-[15rem] flex-1 cursor-pointer gap-2 rounded-lg border-[1.5px] p-3 text-sm ${ed.fxMode === "spot" ? "border-blue-700 bg-sky-50" : "border-slate-400"}`}><input type="radio" name={`fx-${sku}`} className="mt-0.5 size-5" checked={ed.fxMode === "spot"} disabled={disabled} onChange={() => set((d) => { d.fxMode = "spot"; })} /><span><strong>Spot rate</strong><br /><span className="text-xs text-slate-700">A spot rate older than the rule&rsquo;s limit expires and blocks pricing.</span></span></label>
              <label className={`flex min-w-[15rem] flex-1 cursor-pointer gap-2 rounded-lg border-[1.5px] p-3 text-sm ${ed.fxMode === "forward" ? "border-blue-700 bg-sky-50" : "border-slate-400"}`}><input type="radio" name={`fx-${sku}`} className="mt-0.5 size-5" checked={ed.fxMode === "forward"} disabled={disabled} onChange={() => set((d) => { d.fxMode = "forward"; })} /><span><strong>My forward-cover contract</strong><br /><span className="text-xs text-slate-700">Needs a contract reference, validity dates and a reason. A Manager attests it.</span></span></label>
            </div>
            {ed.fxMode === "spot" ? (
              <div className="mt-4 flex flex-wrap gap-4"><div className="w-44"><Input label={`${ed.currency} spot rate`} inputMode="decimal" className="tabular-nums" value={ed.spotRateText} disabled={disabled} onChange={(e) => set((d) => { d.spotRateText = e.target.value; })} /></div><div className="min-w-[14rem] flex-1"><Input label="Rate source" value={ed.spotSource} disabled={disabled} onChange={(e) => set((d) => { d.spotSource = e.target.value; })} /></div></div>
            ) : (
              <div className="mt-4 flex flex-wrap gap-4">
                <div className="w-40"><Input label="Forward-cover rate" inputMode="decimal" className="tabular-nums" value={ed.forward.rateText} disabled={disabled} onChange={(e) => set((d) => { d.forward.rateText = e.target.value; })} /></div>
                <div className="w-28"><Input label="Cover days" inputMode="numeric" value={ed.forward.coverDaysText} disabled={disabled} onChange={(e) => set((d) => { d.forward.coverDaysText = e.target.value; })} /></div>
                <div className="min-w-[12rem] flex-1"><Input label="Contract reference" value={ed.forward.reference} disabled={disabled} onChange={(e) => set((d) => { d.forward.reference = e.target.value; })} /></div>
                <div className="w-40"><Input label="Valid from" placeholder="YYYY-MM-DD" value={ed.forward.validFrom} disabled={disabled} onChange={(e) => set((d) => { d.forward.validFrom = e.target.value; })} /></div>
                <div className="w-40"><Input label="Valid until" placeholder="YYYY-MM-DD" value={ed.forward.validUntil} disabled={disabled} onChange={(e) => set((d) => { d.forward.validUntil = e.target.value; })} /></div>
                <div className="min-w-[14rem] flex-[1_1_100%]"><Input label="Why this rate applies" value={ed.forward.reason} disabled={disabled} onChange={(e) => set((d) => { d.forward.reason = e.target.value; })} /></div>
              </div>
            )}
          </Section>
        )}
        <Section title="Freight and landed cost">
          <div className="flex flex-wrap gap-4">
            <div className="w-44"><Input label="Freight factor" inputMode="decimal" className="tabular-nums" value={ed.freightFactorText} disabled={disabled} onChange={(e) => set((d) => { d.freightFactorText = e.target.value; })} helperText="1 means none. 1.2 adds 20%." /></div>
            <div className="w-52"><Input label="Fixed add-on per unit (R)" inputMode="decimal" className="tabular-nums" value={ed.addOnText} disabled={disabled} onChange={(e) => set((d) => { d.addOnText = e.target.value; })} helperText="Duty, clearing, local freight." /></div>
            <div className="min-w-[12rem] flex-1"><Input label="Freight source" value={ed.freightSource} disabled={disabled} onChange={(e) => set((d) => { d.freightSource = e.target.value; })} /></div>
          </div>
        </Section>
        <Section title="Selling price">
          <p className="text-sm text-slate-800">The selling price is calculated by the pricing model from the landed cost and the project rule. {pv?.priceCents != null && <strong className="tabular-nums" data-testid="calc-price-inline">{money(pv.priceCents / 100)} each, ex VAT.</strong>}</p>
          <label className="mt-3 flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" className="size-5" checked={ed.override.on} disabled={disabled} onChange={(e) => set((d) => { d.override.on = e.target.checked; })} /><span><strong>Quote a different selling price for this product</strong> <span className="text-slate-700">(an exception: needs a reason, shown as an override, audited)</span></span></label>
          {ed.override.on && (
            <div className="mt-2 flex flex-wrap gap-4"><div className="w-44"><Input label="Selling price each (R)" inputMode="decimal" className="tabular-nums" value={ed.override.priceText} disabled={disabled} onChange={(e) => set((d) => { d.override.priceText = e.target.value; })} /></div><div className="min-w-[14rem] flex-1"><Input label="Reason for the override" value={ed.override.reason} disabled={disabled} onChange={(e) => set((d) => { d.override.reason = e.target.value; })} /></div></div>
          )}
          <Hint>Cost overrides of the old Cin7 cost capture do not apply once supplier pricing is on: the supplier cost above is the cost. This selling-price override is the existing authorised exception.</Hint>
        </Section>
        <div className="rounded-lg bg-sky-50 px-4 py-3 text-[13px] text-sky-950">A Manager verifies this cost independently. You cannot verify your own entry. The Rep never sees cost, rate or margin.</div>
        {errors.length > 0 && <Alert tone="warning"><ul className="list-disc pl-5" data-testid="save-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" className="min-h-11" loading={busy} disabled={!canEdit || problems.length > 0 || busy || !dirty} onClick={doSave} aria-describedby={`${testId}-why`}>{saveLabel}</Button>
          <span id={`${testId}-why`} className="text-sm text-amber-900" data-testid="save-why" role="status">{!canEdit ? "Only an Estimator can enter pricing." : problems.length > 0 ? `Needs: ${problems[0]}` : !dirty ? (saved ?? "No unsaved changes.") : "Ready to save."}</span>
        </div>
      </div>
      <aside aria-labelledby={`${testId}-calc`} className="flex min-w-0 flex-[1_1_16rem] flex-col gap-2 rounded-xl border border-slate-200 bg-white p-5 text-sm lg:max-w-xs" data-testid="live-calc">
        <h3 id={`${testId}-calc`} className="text-base font-bold">This line, as you type</h3>
        {!pv ? <p className="text-slate-700">Complete the fields to see the calculated price. Nothing is shown from partly typed values.</p> : (
          <>
            <div className="flex justify-between"><span>Landed cost each</span><span className="tabular-nums">{pv.landedCents == null ? "—" : money(pv.landedCents / 100)}</span></div>
            <div className="flex justify-between font-bold"><span>Selling price each</span><span className="tabular-nums">{pv.priceCents == null ? "not priced" : money(pv.priceCents / 100)}</span></div>
            <div className="flex justify-between border-t border-slate-200 pt-2"><span>× {quantity.toLocaleString("en-ZA").replace(/\s/g, ",")}</span><strong className="tabular-nums">{pv.lineRevenueCents == null ? "—" : money(pv.lineRevenueCents / 100)}</strong></div>
            <div className="flex justify-between text-slate-700"><span>Indicative margin</span><span className="tabular-nums">{pv.margin?.marginPct == null ? "—" : `${pv.margin.marginPct.toFixed(1)}%`}</span></div>
            <p className="text-xs font-semibold text-amber-900">UNVERIFIED. It becomes a verified margin only after a Manager verifies the cost.</p>
            {pv.issues.length > 0 && <ul className="list-disc pl-5 text-xs text-amber-900">{pv.issues.map((i) => <li key={i}>{i}</li>)}</ul>}
          </>
        )}
        {row && <p className="border-t border-slate-200 pt-2 text-xs text-slate-700" data-testid="stored-state">Saved state: {row.costStateText}.</p>}
        <p className="text-xs text-slate-600">The calculation is the existing pricing model. Nothing here changes how a price is worked out.</p>
      </aside>
    </div>
  );
}
function parseProblem(text: string): string | undefined { const c = parseCostText(text); return c.kind === "bad" ? c.message : undefined; }

/** Manual quotation price with its REASON and EVIDENCE (both mandatory), stored in the existing reason field in the labelled format. Provisional wherever it appears. */
export function ManualPriceForm({ itemKey, label, quantity, existing, canEdit, parts, save, onDirty, onSaved, remove }: {
  itemKey: string; label: string; quantity: number; existing: { unitPriceExVat: number; reason: string } | undefined; canEdit: boolean; parts?: ReactNode;
  save: (itemKey: string, unitPrice: number, storedReason: string) => Promise<SaveResult>; onDirty: (d: boolean) => void; onSaved?: () => void; remove?: (itemKey: string) => Promise<SaveResult>;
}) {
  const dec = decodeManualReason(existing?.reason);
  const [initial, setInitial] = useState(() => ({ price: existing ? String(existing.unitPriceExVat) : "", reason: dec.reason, evidence: dec.evidence }));
  const [price, setPrice] = useState(initial.price);
  const [reason, setReason] = useState(initial.reason);
  const [evidence, setEvidence] = useState(initial.evidence);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const n = Number(price.replace(/\s/g, "").replace(",", "."));
  const unit = price.trim() !== "" && Number.isFinite(n) ? n : null;
  const dirty = price !== initial.price || reason !== initial.reason || evidence !== initial.evidence;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const complete = manualPriceComplete(reason, evidence, unit);
  const missing = unit === null || unit <= 0 ? "Enter a price above zero." : reason.trim().length < 3 ? "Enter the reason." : evidence.trim().length < 10 ? "Enter the pricing evidence (at least 10 characters: quote reference, date, who gave it)." : evidence.trim().length > 500 ? "The pricing evidence is too long (at most 500 characters)." : null;
  async function doSave() {
    if (!complete || busy || unit === null) return;
    setBusy(true); setErrors([]); setSaved(null);
    try {
      const r = await save(itemKey, Math.round(unit * 100) / 100, encodeManualReason(reason, evidence));
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : ["Could not save. Nothing you typed was lost."]); return; }
      setInitial({ price, reason, evidence }); setSaved("Saved."); onDirty(false); onSaved?.();
    } catch { setErrors(["That did not complete (the connection or the server failed). Nothing you typed was lost."]); } finally { setBusy(false); }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start" data-testid="manual-form">
      <div className="flex min-w-0 flex-[1_1_28rem] flex-col gap-4">
        <div className="flex gap-3 rounded-xl border-2 border-amber-600 bg-amber-50 px-4 py-3 text-sm text-amber-950" data-testid="provisional-banner"><span className="mt-0.5 h-fit shrink-0 rounded bg-amber-800 px-2 py-0.5 text-xs font-bold text-white">PROVISIONAL</span><span><strong>Manual quotation price.</strong> This line is not priced from a supplier cost or the approved price source. It is labelled manual and provisional wherever it appears, including Manager approval, until NewQuip settles the product.</span></div>
        {parts}
        <Section title="Your quotation price" hint={`${label} · per unit, ex VAT`}>
          <div className="w-56"><Input label="Price each (R)" inputMode="decimal" className="tabular-nums" value={price} disabled={!canEdit || busy} onChange={(e) => { setSaved(null); setPrice(e.target.value); }} helperText="Required. Must be more than zero." /></div>
          <div className="mt-4"><label htmlFor="mp-reason" className="mb-1.5 block text-[13px] font-semibold">Reason</label><textarea id="mp-reason" rows={2} className={areaCls} value={reason} disabled={!canEdit || busy} onChange={(e) => { setSaved(null); setReason(e.target.value); }} /><Hint>Required. Why the normal price source cannot price this line.</Hint></div>
          <div className="mt-4"><label htmlFor="mp-evidence" className="mb-1.5 block text-[13px] font-semibold">Pricing evidence</label><textarea id="mp-evidence" rows={2} className={areaCls} value={evidence} disabled={!canEdit || busy} onChange={(e) => { setSaved(null); setEvidence(e.target.value); }} /><Hint>Required. Quote reference, date, validity and who gave it. Shown to the Manager with your reason, and kept with the price (it also satisfies the approval's pricing-evidence record). At least 10 characters.</Hint></div>
          {complete && unit !== null && <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm tabular-nums">{quantity.toLocaleString("en-ZA").replace(/\s/g, ",")} × {money(unit)} = <strong>{money(unit * quantity)}</strong> ex VAT <span className="text-slate-700">· no cost, so no margin is calculated for this line</span></p>}
        </Section>
        <div className="rounded-lg bg-sky-50 px-4 py-3 text-[13px] text-sky-950">There is no supplier cost to verify on a manual price. The Manager reads your reason and evidence at approval and sees the line marked manual and provisional. The Rep sees only the price.</div>
        {errors.length > 0 && <Alert tone="warning"><ul className="list-disc pl-5" data-testid="save-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" className="min-h-11" loading={busy} disabled={!canEdit || !complete || busy || !dirty} onClick={doSave} aria-describedby="mp-why">Save manual price</Button>
          {existing && remove && canEdit && <Button type="button" variant="secondary" className="min-h-11" disabled={busy} onClick={async () => { setBusy(true); try { const r = await remove(itemKey); if (!r.ok) setErrors(r.errors ?? ["Could not remove."]); else onSaved?.(); } finally { setBusy(false); } }}>Remove the manual price</Button>}
          <span id="mp-why" role="status" className="text-sm text-amber-900" data-testid="save-why">{!canEdit ? "Only an Estimator can enter a manual price." : missing ?? (!dirty ? (saved ?? "No unsaved changes.") : "Ready to save.")}</span>
        </div>
      </div>
      <aside className="flex min-w-0 flex-[1_1_16rem] flex-col gap-2 rounded-xl border border-slate-200 bg-white p-5 text-sm lg:max-w-xs" aria-label="This line">
        <h3 className="text-base font-bold">This line</h3>
        <span className="w-fit rounded bg-amber-800 px-2 py-0.5 text-xs font-bold text-white">PROVISIONAL · MANUAL PRICE</span>
        <div className="flex justify-between"><span>Price each</span><span className="tabular-nums">{unit && unit > 0 ? money(unit) : "—"}</span></div>
        <div className="flex justify-between text-slate-700"><span>Supplier cost</span><span>not applicable</span></div>
        <div className="flex justify-between text-slate-700"><span>Margin</span><span>none for this line</span></div>
        {dec.legacy && existing && <p className="text-xs text-amber-900" data-testid="legacy-reason">This price was recorded before reason and evidence were kept separately. Its text is shown as the reason; add the evidence.</p>}
      </aside>
    </div>
  );
}

/** PVC door (and any other product with no recommended SKU): choose the product, save it alone or with its price. */
export function ProductChoice({ itemKey, label, chosen, canEdit, busy, onChoose, children }: { itemKey: string; label: string; chosen: string | undefined; canEdit: boolean; busy: boolean; onChoose: (sku: string | null) => void; children?: ReactNode }) {
  const candidates = manualSelectionSkusFor(itemKey as GrowerItemKey);
  return (
    <Section title={`Step 1. Choose the ${label.toLowerCase()} product`} hint={candidates.length ? "there is no sizing rule, so this is your call" : "search the Cin7 catalogue"} testId="product-choice">
      {candidates.length > 0 ? (
        <div role="radiogroup" aria-label={`${label} product`} className="flex flex-col gap-2">
          {candidates.map((s) => <label key={s} className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border-[1.5px] px-3.5 py-2.5 text-sm ${chosen === s ? "border-blue-700 bg-sky-50" : "border-slate-400"}`}><input type="radio" name={`product-${itemKey}`} className="size-5" checked={chosen === s} disabled={!canEdit || busy} onChange={() => onChoose(s)} /><span><strong>{s}</strong>{PRODUCT_NAMES[s] ? ` · ${PRODUCT_NAMES[s]}` : ""}</span></label>)}
        </div>
      ) : <ProductMappingPicker label={label} value={chosen} disabled={!canEdit || busy} onChange={onChoose} />}
      <Hint>The product is checked as active in the synced Cin7 catalogue when it is saved and again at sign-off.</Hint>
      {children}
    </Section>
  );
}
const PRODUCT_NAMES: Record<string, string> = { NQ2112: "WHITE DOOR WITH UV 35MM (1980L × 600W)", NQ2113: "WHITE DOOR WITH UV 35MM (1980L × 1000W) NO WINDOWS", NQ2114: "WHITE DOOR WITH UV 35MM (1970L × 1000W)", NQ2161: "WHITE DOOR WITH UV 35MM (1980 × 1000W) WITH WINDOWS", NQ2281: "35MM WHITE DOOR (1990 × 790MM)" };

/** Cup drinker: confirm the seven-component package (existing definition), then cost each component. */
export function PackageConfirm({ itemKey, confirmed, canEdit, busy, onConfirm }: { itemKey: string; confirmed: boolean; canEdit: boolean; busy: boolean; onConfirm: (yes: boolean) => void }) {
  const pkg = packageFor(itemKey as GrowerItemKey);
  return (
    <Section title={`A. Confirm the ${pkg?.components.length ?? 7}-component package`} hint="the existing, supported pricing path" testId="package-confirm">
      <label className={`flex cursor-pointer items-start gap-3 rounded-lg border-[1.5px] p-3 text-sm ${confirmed ? "border-blue-700 bg-sky-50" : "border-slate-400"}`}>
        <input type="checkbox" className="mt-0.5 size-5" checked={confirmed} disabled={!canEdit || busy} onChange={(e) => onConfirm(e.target.checked)} />
        <span>I confirm this package is priced from its {pkg?.components.length ?? 7} components below ({pkg?.components.map((c) => `${c.qtyPerUnit ?? ""} ${c.description}`.trim()).join("; ")}). Each is a Cin7 product. <span className="text-slate-700">Recorded with your name and the time when saved.</span></span>
      </label>
    </Section>
  );
}

/** The M75 system price: the Estimator's commercial price per system, ex VAT. It is NOT a product mapping and has no supplier cost, so there is no cost, FX or verification here. Saved through the draft save. */
export function M75PriceForm({ itemKey, label, quantity, existing, canEdit, save, onDirty, onSaved }: {
  itemKey: string; label: string; quantity: number; existing: number | null | undefined; canEdit: boolean;
  save: (itemKey: string, unitPrice: number) => Promise<SaveResult>; onDirty: (d: boolean) => void; onSaved?: () => void;
}) {
  const [initial, setInitial] = useState(existing != null ? String(existing) : "");
  const [price, setPrice] = useState(initial);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const n = Number(price.replace(/\s/g, "").replace(",", "."));
  const unit = price.trim() !== "" && Number.isFinite(n) ? n : null;
  const dirty = price !== initial;
  useEffect(() => { onDirty(dirty); }, [dirty, onDirty]);
  const ok = unit !== null && unit > 0;
  async function doSave() {
    if (!ok || busy || unit === null) return;
    setBusy(true); setErrors([]); setSaved(null);
    try {
      const r = await save(itemKey, Math.round(unit * 100) / 100);
      if (!r.ok) { setErrors(r.errors?.length ? r.errors : ["Could not save. Nothing you typed was lost."]); return; }
      setInitial(price); setSaved("Saved."); onDirty(false); onSaved?.();
    } catch { setErrors(["That did not complete (the connection or the server failed). Nothing you typed was lost."]); } finally { setBusy(false); }
  }
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="m75-form">
      <Section title="M75 system price" hint={`${label} · per system, ex VAT`}>
        <p className="mb-3 text-sm text-slate-800">The M75 system is priced by you, by design (client preference). It is not a product mapping and has no supplier cost, so there is no cost, exchange rate or verification step for it. A zero is never a price.</p>
        <div className="w-56"><Input label="Price per system (R)" inputMode="decimal" className="tabular-nums" value={price} disabled={!canEdit || busy} onChange={(e) => { setSaved(null); setPrice(e.target.value); }} helperText="Required. Must be more than zero." /></div>
        {ok && unit !== null && <p className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm tabular-nums">{quantity.toLocaleString("en-ZA").replace(/\s/g, ",")} × {money(unit)} = <strong>{money(unit * quantity)}</strong> ex VAT</p>}
      </Section>
      {errors.length > 0 && <Alert tone="warning"><ul className="list-disc pl-5" data-testid="save-errors">{errors.map((e) => <li key={e}>{e}</li>)}</ul></Alert>}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" className="min-h-11" loading={busy} disabled={!canEdit || !ok || busy || !dirty} onClick={doSave} aria-describedby="m75-why">Save M75 price</Button>
        <span id="m75-why" role="status" className="text-sm text-amber-900" data-testid="save-why">{!canEdit ? "Only an Estimator can enter the M75 price." : !ok ? "Enter a price above zero." : !dirty ? (saved ?? "No unsaved changes.") : "Ready to save."}</span>
      </div>
    </div>
  );
}
