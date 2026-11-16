"use client";

import { useCallback, useEffect, useState } from "react";
import { Input } from "@/components/ui/Input";
import type { SkuEditor } from "@/newquip/quote/workspace-submission";
import { parseCostText } from "@/newquip/quote/workspace-submission";
import { priceAge } from "@/newquip/pricing/estimator/supplier-identity";
import { getSkuCostContextAction, searchCin7SuppliersAction, type SkuCostContext, type SkuSupplierRecord, type SupplierHit } from "../supplier-actions";

// THE SUPPLIER AND COST FIELDS OF A SUPPLIER COST, the same in the first-task (activation) form and in every product editor. The supplier is CHOSEN from the connected Cin7 catalogue (the product's own suppliers first,
// then a search of the other active suppliers); its Cin7 id is what is stored and its currency is DERIVED from its Cin7 record, never typed. Where Cin7 holds no currency there is one clearly marked exception: set it
// by hand, with a reason. What Cin7 already holds for the product (price, currency, last-supplied date) is shown BEFORE anything is requested, and the four kinds of cost are never blurred.
const CURRENCIES = ["ZAR", "USD", "EUR", "GBP", "AUD", "CNY", "JPY", "CHF", "NZD"];
const fmtDate = (d: string | null): string => (d ? d : "date not recorded");

type Ctx = { state: "loading" } | { state: "ok"; data: SkuCostContext } | { state: "error"; message: string };

export function SupplierCostSection({ quoteId, sku, ed, set, disabled }: { quoteId: string; sku: string; ed: SkuEditor; set: (f: (e: SkuEditor) => void) => void; disabled: boolean }) {
  const [ctx, setCtx] = useState<Ctx>({ state: "loading" });
  const fetchCtx = useCallback(() => {
    void getSkuCostContextAction(quoteId, sku).then((r) => setCtx(r.ok && r.data ? { state: "ok", data: r.data } : { state: "error", message: r.error ?? "Cin7 supplier data is not available right now." }), () => setCtx({ state: "error", message: "Cin7 supplier data is not available right now." }));
  }, [quoteId, sku]);
  useEffect(() => { fetchCtx(); }, [fetchCtx]);
  const loadCtx = () => { setCtx({ state: "loading" }); fetchCtx(); }; // the "Try again" button

  // The search: the result carries the text it answers, so a stale answer (or a cleared box) is simply not shown. No state is set synchronously from an effect.
  const [query, setQuery] = useState("");
  const [res, setRes] = useState<{ q: string; list?: SupplierHit[]; total?: number; truncated?: boolean; error?: string } | null>(null);
  const q = query.trim();
  useEffect(() => {
    if (q.length < 2) return;
    const t = setTimeout(() => {
      void searchCin7SuppliersAction(quoteId, q).then(
        (r) => setRes(r.ok && r.data ? { q, list: r.data.hits, total: r.data.total, truncated: r.data.truncated } : { q, error: r.error ?? "Cin7 supplier data is not available right now." }),
        () => setRes({ q, error: "Cin7 supplier data is not available right now." }),
      );
    }, 300);
    return () => clearTimeout(t);
  }, [q, quoteId]);
  const answered = q.length >= 2 && res !== null && res.q === q ? res : null;
  const searching = q.length >= 2 && !answered;
  const hits = answered && !answered.error ? { list: answered.list ?? [], total: answered.total ?? 0, truncated: !!answered.truncated } : null;
  const searchError = answered?.error ?? null;

  const records: SkuSupplierRecord[] = ctx.state === "ok" ? ctx.data.suppliers : [];
  const chosenRecord = ed.supplierId ? records.find((r) => r.supplierId === ed.supplierId) ?? null : null;
  const currencyClash = !!chosenRecord && !!chosenRecord.currency && !!chosenRecord.productCurrency && chosenRecord.currency !== chosenRecord.productCurrency;
  const historicalAvailable = !!chosenRecord && chosenRecord.cost !== null && !currencyClash;

  function chooseSupplier(id: string, name: string, currency: string | null) {
    set((d) => {
      const changed = d.supplierId !== id;
      d.supplierId = id; d.supplierName = name;
      if (currency) { d.currency = currency; d.currencySource = "cin7_supplier"; d.currencyOverrideReason = ""; }
      else { d.currency = ""; d.currencySource = "override"; if (changed) d.currencyOverrideReason = ""; }
      if (changed && d.costKind === "cin7_historical") { d.costKind = null; d.costText = ""; d.costDate = ""; }
    });
    setQuery("");
  }
  function chooseKind(kind: SkuEditor["costKind"]) {
    set((d) => {
      d.costKind = kind;
      if (kind === "cin7_historical" && chosenRecord && chosenRecord.cost !== null) { if (d.currencySource === "override" && !d.currency && chosenRecord.productCurrency) d.currency = chosenRecord.productCurrency; d.costText = chosenRecord.cost; d.costDate = chosenRecord.lastSupplied ?? ""; d.source = `Cin7 latest supplier price from ${chosenRecord.supplierName} (last supplied ${fmtDate(chosenRecord.lastSupplied)})`; }
      if (kind !== "supplier_quotation" && kind !== "cin7_historical") d.costDate = "";
    });
  }
  const KIND: Array<{ id: NonNullable<SkuEditor["costKind"]>; title: string; text: string; off?: boolean }> = [
    { id: "cin7_historical", title: "Cin7 historical cost", text: currencyClash ? `Not available: Cin7 prices this product from ${chosenRecord!.supplierName} in ${chosenRecord!.productCurrency}, but the supplier's own currency is ${chosenRecord!.currency}. Enter a quotation instead.` : historicalAvailable ? "The price Cin7 already holds from this supplier for this product." : "Needs a supplier that Cin7 already lists for this product, with a price.", off: !historicalAvailable },
    { id: "supplier_quotation", title: "New supplier quotation", text: "A current quotation you hold. Needs the quotation date and its reference." },
    { id: "manual_estimate", title: "Manually estimated cost", text: "Your own estimate. It is recorded as an estimate, not a supplier price." },
  ];

  return (
    <div className="flex flex-col gap-5" data-testid="supplier-cost-section">
      {/* 1 · what Cin7 already holds */}
      <div className="rounded-lg border border-slate-300 bg-slate-50 p-3" data-testid="cin7-context">
        <h4 className="text-sm font-bold text-slate-900">What Cin7 already holds for this product</h4>
        {ctx.state === "loading" && <p className="mt-1 text-sm text-slate-700" role="status" data-testid="cin7-context-loading">Reading Cin7…</p>}
        {ctx.state === "error" && (
          <p className="mt-1 text-sm text-amber-950" role="alert" data-testid="cin7-context-error">{ctx.message} <button type="button" className="min-h-11 font-semibold text-blue-800 underline" onClick={loadCtx}>Try again</button></p>
        )}
        {ctx.state === "ok" && (
          <>
            {!ctx.data.found && <p className="mt-1 text-sm text-slate-800" data-testid="cin7-not-found">Cin7 does not return this product, so there is no Cin7 supplier price to show.</p>}
            {ctx.data.found && records.length === 0 && <p className="mt-1 text-sm text-slate-800" data-testid="cin7-no-suppliers">Cin7 lists no supplier for this product. Search the other Cin7 suppliers below.</p>}
            {records.length > 0 && (
              <ul className="mt-2 flex flex-col gap-2" data-testid="cin7-supplier-records">
                {records.map((r) => (
                  <li key={r.supplierId}>
                    <button type="button" disabled={disabled || !r.active} onClick={() => chooseSupplier(r.supplierId, r.supplierName, r.currency)} aria-pressed={ed.supplierId === r.supplierId} data-testid={`cin7-record-${r.supplierId}`}
                      className={`flex min-h-11 w-full flex-wrap items-baseline justify-between gap-x-4 rounded-lg border-[1.5px] px-3 py-2 text-left text-sm ${ed.supplierId === r.supplierId ? "border-blue-700 bg-sky-50" : "border-slate-400 bg-white hover:bg-slate-50"} disabled:opacity-60`}>
                      <span className="font-semibold text-slate-900">{r.supplierName}{!r.active && <span className="ml-2 text-xs font-normal text-amber-900">inactive in Cin7: cannot be chosen</span>}</span>
                      <span className="text-slate-800">{r.cost ? <><span className="tabular-nums">{r.productCurrency ?? r.currency ?? "currency not held"} {r.cost}</span> · last supplied {fmtDate(r.lastSupplied)}{(() => { const a = priceAge(r.lastSupplied, new Date().toISOString()); return a ? ` (${a.text})` : ""; })()}</> : "no price held in Cin7"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {ctx.data.averageCostUndated && <p className="mt-2 text-xs text-slate-700" data-testid="cin7-average-cost">Cin7 also holds an average cost of {ctx.data.averageCostUndated}. It has no date or supplier, so it is shown for reference only and is never used as a supplier cost.</p>}
            <p className="mt-1 text-xs text-slate-700">A price Cin7 holds without a date stays undated here: no date is assumed.</p>
          </>
        )}
      </div>

      {/* 2 · the supplier: chosen, never typed */}
      <div data-testid="supplier-picker">
        <p className="mb-1.5 text-[13px] font-semibold text-slate-900">Supplier (from Cin7)</p>
        {ed.supplierId ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border-[1.5px] border-slate-500 bg-white px-3 py-2" data-testid="supplier-selected">
            <span className="text-[15px] font-semibold text-slate-900">{ed.supplierName}</span>
            <span className="text-xs text-slate-700">Cin7 supplier</span>
            {!disabled && <button type="button" className="ml-auto min-h-11 text-sm font-semibold text-blue-800 underline" onClick={() => set((d) => { d.supplierId = null; d.supplierName = ""; d.currency = ""; d.currencySource = null; d.currencyOverrideReason = ""; d.costKind = null; d.costText = ""; d.costDate = ""; })} data-testid="supplier-change">Change supplier</button>}
          </div>
        ) : (
          <>
            <Input label="Search all active Cin7 suppliers by name" value={query} disabled={disabled} onChange={(e) => setQuery(e.target.value)} helperText={ctx.state === "ok" && records.length > 0 ? "Or choose one of this product's suppliers above." : "Type at least two letters."} data-testid="supplier-search" />
            <div role="status" aria-live="polite" className="mt-1 text-sm text-slate-800" data-testid="supplier-search-status">
              {searching ? "Searching Cin7…" : searchError ? <span className="text-amber-950">{searchError}</span> : hits ? (hits.total === 0 ? "No active Cin7 supplier matches." : `${hits.total} matching supplier${hits.total === 1 ? "" : "s"}${hits.truncated ? " (showing the first 25: refine the search)" : ""}`) : ""}
            </div>
            {hits && hits.list.length > 0 && (
              <ul className="mt-1 flex max-h-64 flex-col gap-1.5 overflow-y-auto" data-testid="supplier-hits">
                {hits.list.map((h) => (
                  <li key={h.supplierId}><button type="button" disabled={disabled} onClick={() => chooseSupplier(h.supplierId, h.name, h.currency)} data-testid={`supplier-hit-${h.supplierId}`} className="flex min-h-11 w-full flex-wrap items-baseline justify-between gap-x-4 rounded-lg border-[1.5px] border-slate-400 bg-white px-3 py-2 text-left text-sm hover:bg-slate-50 disabled:opacity-60"><span className="font-semibold text-slate-900">{h.name}</span><span className="text-slate-800">{h.currency ?? "no currency in Cin7"}</span></button></li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      {/* 3 · the currency: derived, or the one marked exception */}
      {ed.supplierId && ed.currencySource === "cin7_supplier" && (
        <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950" data-testid="derived-currency">Currency: <strong>{ed.currency}</strong>, from {ed.supplierName}&apos;s Cin7 supplier record. It is not typed.</p>
      )}
      {ed.supplierId && ed.currencySource === "override" && (
        <div className="rounded-lg border-2 border-amber-600 bg-amber-50 p-3" data-testid="currency-exception">
          <p className="text-sm font-bold text-amber-950">Exception: Cin7 holds no currency for {ed.supplierName}</p>
          <p className="mt-1 text-sm text-amber-950">Choose the currency this supplier invoices in and say why. This is recorded against the cost and shown to the Manager who verifies it. Nothing is assumed.</p>
          <div className="mt-2 flex flex-wrap items-start gap-4">
            <div className="w-40"><label className="mb-1.5 block text-[13px] font-semibold text-slate-900" htmlFor={`cur-${sku}`}>Currency</label>
              <select id={`cur-${sku}`} disabled={disabled} value={ed.currency} onChange={(e) => set((d) => { d.currency = e.target.value; })} className="min-h-11 w-full rounded-lg border-[1.5px] border-slate-500 bg-white px-3 text-[15px]" data-testid="currency-override-select">
                <option value="">Choose…</option>{CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
              </select></div>
            <div className="min-w-[14rem] flex-1"><Input label="Why is the currency set by hand?" value={ed.currencyOverrideReason} disabled={disabled} onChange={(e) => set((d) => { d.currencyOverrideReason = e.target.value; })} helperText="At least 10 characters." data-testid="currency-override-reason" /></div>
          </div>
        </div>
      )}

      {/* 4 · what kind of cost: never blurred */}
      <fieldset disabled={disabled} className="min-w-0 border-0 p-0" data-testid="cost-kind">
        <legend className="mb-1.5 text-[13px] font-semibold text-slate-900">What kind of cost is this?</legend>
        <div className="flex flex-wrap gap-3">
          {KIND.map((k) => (
            <label key={k.id} className={`flex min-w-[14rem] flex-1 gap-2 rounded-lg border-[1.5px] p-3 text-sm ${k.off ? "cursor-not-allowed border-slate-300 text-slate-600" : "cursor-pointer"} ${ed.costKind === k.id ? "border-blue-700 bg-sky-50" : "border-slate-400"}`}>
              <input type="radio" name={`kind-${sku}`} className="mt-0.5 size-5" checked={ed.costKind === k.id} disabled={k.off || disabled} onChange={() => chooseKind(k.id)} data-testid={`kind-${k.id}`} />
              <span><span className="block font-semibold text-slate-900">{k.title}</span><span className="block text-[12.5px] text-slate-700">{k.text}</span></span>
            </label>
          ))}
          <div className="flex min-w-[14rem] flex-1 gap-2 rounded-lg border-[1.5px] border-dashed border-slate-300 p-3 text-sm text-slate-600" data-testid="kind-aged-unavailable">
            <span className="mt-0.5 size-5 shrink-0 rounded-full border border-slate-300" aria-hidden />
            <span><span className="block font-semibold">Age-adjusted estimate</span><span className="block text-[12.5px]">Not available. There is no approved policy for ageing an old cost, so none is calculated.</span></span>
          </div>
        </div>
      </fieldset>

      {/* 5 · only the information the chosen kind needs */}
      <div className="flex flex-wrap gap-4">
        <div className="min-w-[10rem] flex-[1_1_11rem]"><Input label="Unit cost (up to 7 decimals)" inputMode="decimal" className="tabular-nums" value={ed.costText} disabled={disabled || ed.costKind === "cin7_historical"} readOnly={ed.costKind === "cin7_historical"} onChange={(e) => set((d) => { d.costText = e.target.value; })} error={(() => { const c = parseCostText(ed.costText); return c.kind === "bad" ? c.message : undefined; })()} helperText={ed.costKind === "cin7_historical" ? "Taken from Cin7 and not editable: a different figure is a new quotation." : undefined} data-testid="unit-cost" /></div>
        {ed.costKind === "supplier_quotation" && <div className="w-44"><Input label="Quotation date" placeholder="YYYY-MM-DD" value={ed.costDate} disabled={disabled} onChange={(e) => set((d) => { d.costDate = e.target.value; })} data-testid="cost-date" /></div>}
        {ed.costKind === "cin7_historical" && chosenRecord?.cost && chosenRecord.cost !== ed.costText && <p className="basis-full rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-950" data-testid="historical-refresh">Cin7 now holds {chosenRecord.cost}. <button type="button" className="min-h-11 font-semibold text-blue-800 underline" onClick={() => chooseKind("cin7_historical")}>Use Cin7&apos;s current price</button></p>}
        {ed.costKind === "cin7_historical" && (() => { const a = priceAge(ed.costDate || null, new Date().toISOString()); return a?.stale ? <p className="basis-full rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="stale-cost-warning">This Cin7 price was last supplied {a.text}. Confirm it is still current, or enter a new supplier quotation instead. Nothing is adjusted for its age.</p> : null; })()}
        {ed.costKind === "cin7_historical" && <div className="w-56 text-sm text-slate-800" data-testid="historical-date"><span className="mb-1.5 block text-[13px] font-semibold text-slate-900">Cost date (Cin7)</span>{ed.costDate ? ed.costDate : "date not recorded in Cin7"}</div>}
      </div>
      <Input label="Where this cost comes from" value={ed.source} disabled={disabled} onChange={(e) => set((d) => { d.source = e.target.value; })} helperText={ed.costKind === "manual_estimate" ? "Required: what is the estimate based on? Shown to the Manager who verifies it." : ed.costKind === "supplier_quotation" ? "Required: the quotation reference. Shown to the Manager who verifies it." : "Required. Shown to the Manager who verifies it."} />
      {ed.costKind === "manual_estimate" && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-950" data-testid="estimate-note">This is your estimate, not a supplier price. It is recorded as one and still needs independent verification.</p>}
    </div>
  );
}
