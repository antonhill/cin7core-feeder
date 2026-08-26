"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { ModuleHeader } from "@/app/ModuleHeader";
import { QUOTES_MODULE } from "@/app/module-nav";
import { Spinner } from "@/app/Spinner";
import { PageLoadingIndicator } from "@/app/PageLoadingIndicator";
import { computeLine, computeQuote, type QuoteLineInput } from "@/lib/quote-margin";
import {
  listQuotesAction,
  getQuoteAction,
  saveQuoteAction,
  submitQuoteAction,
  deleteQuoteAction,
  searchQuoteProductsAction,
  searchQuoteCustomersAction,
  resolveQuoteCustomerAction,
  loadQuoteReferenceDataAction,
  type QuoteSummary,
  type QuoteLineDraftInput,
  type QuoteCustomerHit,
  type QuoteReferenceData,
  type QuoteProductHit,
} from "./actions";

// The interactive quote builder. Every margin figure shown here is computed CLIENT-SIDE by the
// same pure engine the server uses (src/lib/quote-margin.ts) — so the numbers on screen match what
// gets persisted — but the server ALWAYS re-sources cost and recomputes on save, so nothing shown
// here is trusted as authoritative. Cost comes from the org's synced Cin7 Average Cost, carried on
// each line for display only (never sent back). ZAR-only for V1.

const money = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });
function fmtMoney(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return money.format(n);
}
function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "N/A";
  return `${n.toFixed(1)}%`;
}
function marginTone(pct: number | null): string {
  if (pct == null) return "text-slate-400";
  if (pct < 0) return "text-red-600";
  if (pct < 15) return "text-amber-600";
  return "text-emerald-600";
}

let uidSeq = 0;
function uid(): string {
  uidSeq += 1;
  return `l${uidSeq}`;
}

interface EditorLine {
  uid: string;
  lineType: "product" | "charge";
  productSku: string;
  productName: string;
  cin7ProductId: string | null;
  /** Display-only quote-time cost; the server re-sources this on save. */
  averageCost: number | null;
  /** This product's synced price per tier_code ("Tier1".."Tier10") — drives the auto unit price. */
  tierPrices: Record<string, number>;
  /** Charge lines only: include this charge in the margin (requires estimatedCost). Default false. */
  marginIncluded: boolean;
  /** Charge lines only: user-entered estimated cost (kept even while excluded, so a toggle back keeps it). */
  estimatedCost: string;
  // Numeric fields kept as strings so the inputs can be empty / mid-typing.
  quantity: string;
  unitPrice: string;
  discountPct: string;
  taxRatePct: string;
}

function num(s: string): number {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/** The charge's entered cost as a number, or null when blank (so a blank never reads as cost 0). */
function chargeEnteredCost(l: EditorLine): number | null {
  return l.estimatedCost.trim() === "" ? null : num(l.estimatedCost);
}

function toEngineInput(l: EditorLine): QuoteLineInput {
  const isCharge = l.lineType === "charge";
  return {
    quantity: num(l.quantity),
    unitPrice: num(l.unitPrice),
    discountPct: num(l.discountPct),
    taxRatePct: num(l.taxRatePct),
    // Product cost is server-known (shown here). A charge only carries a cost when INCLUDED and a
    // value is entered — so an excluded or cost-less charge is never counted (no phantom 100% margin).
    averageCost: isCharge ? (l.marginIncluded ? chargeEnteredCost(l) : null) : l.averageCost,
    excludedFromMargin: isCharge && !l.marginIncluded,
  };
}

function toDraftLine(l: EditorLine): QuoteLineDraftInput {
  const isCharge = l.lineType === "charge";
  return {
    lineType: l.lineType,
    cin7ProductId: l.cin7ProductId,
    productSku: isCharge ? null : l.productSku,
    productName: l.productName,
    quantity: num(l.quantity),
    unitPrice: num(l.unitPrice),
    discountPct: num(l.discountPct),
    taxRatePct: num(l.taxRatePct),
    // Charges carry their treatment + entered cost (preserved even while excluded).
    marginIncluded: isCharge ? l.marginIncluded : undefined,
    estimatedCost: isCharge ? chargeEnteredCost(l) : undefined,
  };
}

export default function QuotesPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  const [mode, setMode] = useState<"list" | "edit">("list");
  const [quotes, setQuotes] = useState<QuoteSummary[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [isLoadingList, startListTransition] = useTransition();

  const loadList = () => {
    startListTransition(async () => {
      const res = await listQuotesAction();
      if (!res.ok) {
        setListError(res.error ?? "Unknown error");
        return;
      }
      setListError(null);
      setQuotes(res.data ?? []);
    });
  };
  useEffect(loadList, []);

  // --- editor state ---
  const [quoteId, setQuoteId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<string>("draft");
  const [customerName, setCustomerName] = useState("");
  const [priceTier, setPriceTier] = useState("");
  const [salesRep, setSalesRep] = useState("");
  const [location, setLocation] = useState("");
  const [taxInclusive, setTaxInclusive] = useState(false);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<EditorLine[]>([]);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [isSaving, startSaveTransition] = useTransition();
  const [isLoadingQuote, startQuoteTransition] = useTransition();

  function resetEditor() {
    setQuoteId(undefined);
    setStatus("draft");
    setCustomerName("");
    setPriceTier("");
    setSalesRep("");
    setLocation("");
    setTaxInclusive(false);
    setNotes("");
    setLines([]);
    setDefaultTaxRatePct("0");
    setEditorError(null);
    setSaveMsg(null);
  }

  function newQuote() {
    resetEditor();
    setMode("edit");
  }

  function openQuote(id: string) {
    setMode("edit");
    setSaveMsg(null);
    setEditorError(null);
    startQuoteTransition(async () => {
      const res = await getQuoteAction(id);
      if (!res.ok || !res.data) {
        setEditorError(res.error ?? "Could not load the quote.");
        return;
      }
      const q = res.data;
      setQuoteId(q.id);
      setStatus(q.status);
      setCustomerName(q.customerName ?? "");
      setPriceTier(q.priceTier ?? "");
      setSalesRep(q.salesRep ?? "");
      setLocation(q.location ?? "");
      setTaxInclusive(q.taxInclusive);
      setNotes(q.notes ?? "");
      picker.setInstanceId(q.instanceId);
      setLines(
        q.lines.map((l) => ({
          uid: uid(),
          lineType: l.lineType === "charge" ? "charge" : "product",
          productSku: l.productSku ?? "",
          productName: l.productName ?? "",
          cin7ProductId: l.cin7ProductId ?? null,
          averageCost: l.averageCost,
          tierPrices: {},
          marginIncluded: l.lineType === "charge" ? Boolean(l.marginIncluded) : false,
          estimatedCost: l.lineType === "charge" && l.averageCost != null ? String(l.averageCost) : "",
          quantity: String(l.quantity),
          unitPrice: String(l.unitPrice),
          discountPct: String(l.discountPct ?? 0),
          taxRatePct: String(l.taxRatePct ?? 0),
        })),
      );
    });
  }

  const readOnly = status !== "draft";

  function updateLine(u: string, patch: Partial<EditorLine>) {
    setLines((prev) => prev.map((l) => (l.uid === u ? { ...l, ...patch } : l)));
  }
  function removeLine(u: string) {
    setLines((prev) => prev.filter((l) => l.uid !== u));
  }
  function addChargeLine() {
    setLines((prev) => [
      ...prev,
      { uid: uid(), lineType: "charge", productSku: "", productName: "", cin7ProductId: null, averageCost: null, tierPrices: {}, marginIncluded: false, estimatedCost: "", quantity: "1", unitPrice: "0", discountPct: "0", taxRatePct: defaultTaxRatePct },
    ]);
  }
  function addProductLine(hit: QuoteProductHit) {
    // Auto-price from the currently-selected tier; falls back to 0 if no tier is chosen or the
    // product has no price at that tier (the user can still type one).
    const tierCode = selectedTierCode();
    const tierPrice = tierCode && hit.tierPrices[tierCode] != null ? hit.tierPrices[tierCode] : 0;
    setLines((prev) => [
      ...prev,
      { uid: uid(), lineType: "product", productSku: hit.sku, productName: hit.name, cin7ProductId: null, averageCost: hit.averageCost, tierPrices: hit.tierPrices, marginIncluded: false, estimatedCost: "", quantity: "1", unitPrice: String(tierPrice), discountPct: "0", taxRatePct: defaultTaxRatePct },
    ]);
  }

  function addServiceCharge(hit: QuoteProductHit) {
    // A Cin7 Service is a charge, not a product line — it has no product cost/margin. Added as a
    // charge (excluded from margin by default, with the option to include an estimated cost), priced
    // from the selected tier like a product. It goes to Cin7 as an additional charge.
    const tierCode = selectedTierCode();
    const tierPrice = tierCode && hit.tierPrices[tierCode] != null ? hit.tierPrices[tierCode] : 0;
    setLines((prev) => [
      ...prev,
      { uid: uid(), lineType: "charge", productSku: "", productName: hit.name, cin7ProductId: null, averageCost: null, tierPrices: {}, marginIncluded: false, estimatedCost: "", quantity: "1", unitPrice: String(tierPrice), discountPct: "0", taxRatePct: defaultTaxRatePct },
    ]);
  }

  function pickSearchHit(hit: QuoteProductHit) {
    if (hit.isService) addServiceCharge(hit);
    else addProductLine(hit);
    setSearch("");
    setResults([]);
  }

  // --- product search ---
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<QuoteProductHit[]>([]);
  const [isSearching, startSearchTransition] = useTransition();
  useEffect(() => {
    const q = search.trim();
    // All setState is deferred into this timeout callback (never synchronously in the effect body).
    const t = setTimeout(() => {
      if (q.length < 2) {
        setResults([]);
        return;
      }
      startSearchTransition(async () => {
        const res = await searchQuoteProductsAction(q);
        setResults(res.ok ? res.data ?? [] : []);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [search]);

  // --- customer search (typeahead over synced customers) ---
  const [custSearch, setCustSearch] = useState("");
  const [custResults, setCustResults] = useState<QuoteCustomerHit[]>([]);
  const [showCustResults, setShowCustResults] = useState(false);
  const [isCustSearching, startCustTransition] = useTransition();
  const [isResolvingCustomer, startResolveCustomer] = useTransition();
  useEffect(() => {
    const q = custSearch.trim();
    const t = setTimeout(() => {
      if (q.length < 2) {
        setCustResults([]);
        return;
      }
      startCustTransition(async () => {
        const res = await searchQuoteCustomersAction(q);
        setCustResults(res.ok ? res.data ?? [] : []);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [custSearch]);

  function applyCustomerDefaults(d: { priceTier: string | null; salesRep: string | null; location: string | null; taxRule: string | null }) {
    // The customer drives these fields — apply unconditionally (tier via applyPriceTier so existing
    // lines reprice; tax rule via applyCustomerTaxRule so the line VAT % follows).
    if (d.priceTier) applyPriceTier(d.priceTier);
    if (d.salesRep) setSalesRep(d.salesRep);
    if (d.location) setLocation(d.location);
    if (d.taxRule) applyCustomerTaxRule(d.taxRule);
  }

  function pickCustomer(hit: QuoteCustomerHit) {
    setCustomerName(hit.name);
    setCustSearch("");
    setCustResults([]);
    setShowCustResults(false);
    // Apply the synced defaults immediately (optimistic), then refresh from LIVE Cin7 — the local
    // customers table has no continuous sync, so a change made in Cin7 only shows via this lookup.
    applyCustomerDefaults(hit);
    if (!instanceId) return;
    startResolveCustomer(async () => {
      const res = await resolveQuoteCustomerAction(instanceId, hit.name);
      if (res.ok && res.data) applyCustomerDefaults(res.data);
    });
  }

  // --- reference data (Location / Price tier / Sales rep pick-lists) for the chosen instance ---
  const [refData, setRefData] = useState<QuoteReferenceData>({ locations: [], priceTiers: [], salesReps: [], taxRules: [] });
  // The VAT % new lines inherit, resolved from the customer's tax rule (Phase 3's submit re-derives
  // the tax-rule NAME server-side from the customer, so it isn't kept in client state here).
  const [defaultTaxRatePct, setDefaultTaxRatePct] = useState("0");
  const [isLoadingRef, startRefTransition] = useTransition();
  useEffect(() => {
    if (!instanceId) return;
    startRefTransition(async () => {
      const res = await loadQuoteReferenceDataAction(instanceId);
      if (res.ok && res.data) setRefData(res.data);
    });
  }, [instanceId]);

  // A select's options always include its current value, so an auto-filled or stored value that
  // isn't in the fetched list (e.g. a rep no longer active) still shows selected rather than blank.
  function withCurrent(list: string[], current: string): string[] {
    return current && !list.includes(current) ? [current, ...list] : list;
  }

  // The local price_tiers key ("Tier{code}") for the currently-selected tier NAME, or null.
  function selectedTierCode(): string | null {
    const code = refData.priceTiers.find((t) => t.name === priceTier)?.code;
    return code != null ? `Tier${code}` : null;
  }

  // Selecting a price tier re-prices every product line from that tier's synced price — the whole
  // point of choosing a tier. A line whose product has no price at that tier is left unchanged.
  function applyPriceTier(tierName: string) {
    setPriceTier(tierName);
    const code = refData.priceTiers.find((t) => t.name === tierName)?.code;
    const tierCode = code != null ? `Tier${code}` : null;
    if (!tierCode) return;
    setLines((prev) =>
      prev.map((l) =>
        l.lineType === "product" && l.tierPrices[tierCode] != null ? { ...l, unitPrice: String(l.tierPrices[tierCode]) } : l,
      ),
    );
  }

  // Resolve the customer's tax rule (e.g. "Standard Rate Sales") to a VAT % and apply it to every
  // line, and remember it as the default new lines inherit. Kept as the quote's tax rule for submit.
  function applyCustomerTaxRule(taxRuleName: string) {
    const rule = refData.taxRules.find((r) => r.name === taxRuleName);
    if (!rule) return;
    const pct = String(rule.rate);
    setDefaultTaxRatePct(pct);
    setLines((prev) => prev.map((l) => ({ ...l, taxRatePct: pct })));
  }

  // --- live totals (client-side, same engine as the server) ---
  const perLine = useMemo(() => lines.map((l) => computeLine(toEngineInput(l), { taxInclusive })), [lines, taxInclusive]);
  const totals = useMemo(() => computeQuote(lines.map(toEngineInput), { taxInclusive }), [lines, taxInclusive]);

  // Deliberately-excluded charges vs genuinely-unknown product costs are different states (brief §16):
  // the first makes the headline "products only"; the second means the margin is incomplete.
  const excludedChargeCount = lines.filter((l, i) => l.lineType === "charge" && !l.marginIncluded && (perLine[i]?.revenueExTax ?? 0) > 0).length;
  const missingCostCount = lines.filter((l, i) => l.lineType !== "charge" && perLine[i]?.estimatedCost == null && (perLine[i]?.revenueExTax ?? 0) > 0).length;
  const marginLabel = excludedChargeCount > 0 ? "Estimated margin (products only)" : "Estimated overall margin";

  // Including a charge in the margin requires a valid, non-negative cost (mirrors the server).
  function chargeCostError(): string | null {
    for (const l of lines) {
      if (l.lineType !== "charge" || !l.marginIncluded) continue;
      const c = l.estimatedCost.trim();
      if (c === "" || !Number.isFinite(Number(c))) return "Enter an estimated shipping cost before including shipping in margin.";
      if (Number(c) < 0) return "Estimated cost can't be negative.";
    }
    return null;
  }

  function currentQuoteInput() {
    return {
      quoteId,
      instanceId: instanceId as string,
      customerName: customerName.trim() || undefined,
      priceTier: priceTier.trim() || undefined,
      salesRep: salesRep.trim() || undefined,
      location: location.trim() || undefined,
      taxInclusive,
      notes: notes.trim() || undefined,
      lines: lines.map(toDraftLine),
    };
  }

  function save() {
    if (!instanceId) {
      setEditorError("Choose a Cin7 instance first.");
      return;
    }
    const ce = chargeCostError();
    if (ce) {
      setEditorError(ce);
      return;
    }
    setEditorError(null);
    setSaveMsg(null);
    startSaveTransition(async () => {
      const res = await saveQuoteAction(currentQuoteInput());
      if (!res.ok || !res.data) {
        setEditorError(res.error ?? "Could not save the quote.");
        return;
      }
      setQuoteId(res.data.quoteId);
      setSaveMsg("Draft saved.");
      loadList();
    });
  }

  const [isSubmitting, startSubmitTransition] = useTransition();
  function submitToCin7() {
    if (!instanceId) {
      setEditorError("Choose a Cin7 instance first.");
      return;
    }
    const ce = chargeCostError();
    if (ce) {
      setEditorError(ce);
      return;
    }
    setEditorError(null);
    setSaveMsg(null);
    startSubmitTransition(async () => {
      // Persist the latest edits first, then create the sale in Cin7 from the saved quote.
      const saved = await saveQuoteAction(currentQuoteInput());
      if (!saved.ok || !saved.data) {
        setEditorError(saved.error ?? "Could not save before submitting.");
        return;
      }
      setQuoteId(saved.data.quoteId);
      const res = await submitQuoteAction(saved.data.quoteId);
      loadList();
      if (!res.ok || !res.data) {
        setEditorError(res.error ?? "Submit to Cin7 failed.");
        // Reflect the server-side status change (draft/failed) so the button state stays correct.
        const reload = await getQuoteAction(saved.data.quoteId);
        if (reload.ok && reload.data) setStatus(reload.data.status);
        return;
      }
      setStatus("submitted");
      const ref = res.data.cin7QuoteNumber ?? res.data.cin7SaleId;
      setSaveMsg(`Submitted to Cin7 as ${ref}.${res.data.warning ? " " + res.data.warning : ""}`);
    });
  }

  function removeQuote() {
    if (!quoteId) {
      setMode("list");
      return;
    }
    startSaveTransition(async () => {
      const res = await deleteQuoteAction(quoteId);
      if (!res.ok) {
        setEditorError(res.error ?? "Could not delete the quote.");
        return;
      }
      resetEditor();
      setMode("list");
      loadList();
    });
  }

  return (
    <main className="mx-auto w-full max-w-6xl px-6 py-12">
      <ModuleHeader module={QUOTES_MODULE}>
        Build a customer quote with the commercial impact of every line in view — selling price,
        discount, cost, gross profit and margin&nbsp;% per line, plus a weighted overall margin. Cost
        comes from your synced Cin7 Average Cost; Cin7 Core stays the system of record. Amounts are in
        ZAR.
      </ModuleHeader>

      {mode === "list" ? (
        <section className="mt-8">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-900">Your quotes</h2>
            <button
              type="button"
              onClick={newQuote}
              className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700"
            >
              New quote
            </button>
          </div>

          <PageLoadingIndicator show={isLoadingList} label="Loading quotes…" />
          {listError && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{listError}</p>}

          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-slate-500">
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5 text-right">Total (incl. VAT)</th>
                  <th className="px-4 py-2.5 text-right">Margin&nbsp;%</th>
                  <th className="px-4 py-2.5">Updated</th>
                </tr>
              </thead>
              <tbody>
                {quotes.length === 0 && !isLoadingList ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-8 text-center text-slate-400">
                      No quotes yet. Click <span className="font-medium">New quote</span> to build one.
                    </td>
                  </tr>
                ) : (
                  quotes.map((q) => (
                    <tr key={q.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => openQuote(q.id)}>
                      <td className="px-4 py-2.5 font-medium text-slate-900">{q.customerName || <span className="text-slate-400">Untitled</span>}</td>
                      <td className="px-4 py-2.5">
                        <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${q.status === "draft" ? "bg-slate-100 text-slate-600" : "bg-emerald-100 text-emerald-700"}`}>
                          {q.status}
                        </span>
                        {q.cin7QuoteNumber ? <span className="ml-2 text-xs text-slate-400">{q.cin7QuoteNumber}</span> : null}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums">{fmtMoney(q.totalIncTax)}</td>
                      <td className={`px-4 py-2.5 text-right tabular-nums font-medium ${marginTone(q.overallMarginPct)}`}>{fmtPct(q.overallMarginPct)}</td>
                      <td className="px-4 py-2.5 text-slate-500">{new Date(q.updatedAt).toLocaleDateString()}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <section className="mt-8 flex flex-col gap-6">
          <PageLoadingIndicator show={isLoadingQuote} label="Loading quote…" />

          <div className="flex items-center justify-between">
            <button type="button" onClick={() => { setMode("list"); loadList(); }} className="text-sm text-slate-500 hover:text-slate-800">
              ← Back to quotes
            </button>
            {readOnly && (
              <span className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700">
                Submitted to Cin7 — read only
              </span>
            )}
          </div>

          {/* Quote settings */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-slate-700">Instance</span>
                <InstancePicker {...picker} onChange={picker.setInstanceId} />
              </label>
              <label className="relative flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-slate-700">Customer</span>
                <input
                  value={customerName}
                  onChange={(e) => { setCustomerName(e.target.value); setCustSearch(e.target.value); setShowCustResults(true); }}
                  onFocus={() => { if (custResults.length > 0) setShowCustResults(true); }}
                  onBlur={() => setTimeout(() => setShowCustResults(false), 150)}
                  disabled={readOnly}
                  placeholder="Search customers…"
                  className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50"
                />
                {(isCustSearching || isResolvingCustomer) && <div className="absolute right-3 top-9"><Spinner /></div>}
                {showCustResults && custResults.length > 0 && (
                  <ul className="absolute top-full z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                    {custResults.map((c) => (
                      <li key={c.name}>
                        <button type="button" onMouseDown={(e) => { e.preventDefault(); pickCustomer(c); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-indigo-50">
                          <span className="font-medium text-slate-900">{c.name}</span>
                          {(c.priceTier || c.salesRep) && <span className="ml-2 text-xs text-slate-400">{[c.priceTier, c.salesRep].filter(Boolean).join(" · ")}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-slate-700">Location</span>
                <select value={location} onChange={(e) => setLocation(e.target.value)} disabled={readOnly || !instanceId} className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50">
                  <option value="">{isLoadingRef && refData.locations.length === 0 ? "Loading…" : "Choose a location"}</option>
                  {withCurrent(refData.locations, location).map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-slate-700">Price tier</span>
                <select value={priceTier} onChange={(e) => applyPriceTier(e.target.value)} disabled={readOnly || !instanceId} className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50">
                  <option value="">{isLoadingRef && refData.priceTiers.length === 0 ? "Loading…" : "None"}</option>
                  {withCurrent(refData.priceTiers.map((t) => t.name), priceTier).map((t) => <option key={t} value={t}>{t}</option>)}
                </select>
              </label>
              <label className="flex flex-col gap-1.5 text-sm">
                <span className="font-medium text-slate-700">Sales rep</span>
                <select value={salesRep} onChange={(e) => setSalesRep(e.target.value)} disabled={readOnly || !instanceId} className="rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50">
                  <option value="">{isLoadingRef && refData.salesReps.length === 0 ? "Loading…" : "None"}</option>
                  {withCurrent(refData.salesReps, salesRep).map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-2 text-sm sm:mt-6">
                <input type="checkbox" checked={taxInclusive} onChange={(e) => setTaxInclusive(e.target.checked)} disabled={readOnly} className="h-4 w-4" />
                <span className="font-medium text-slate-700">Prices include VAT</span>
              </label>
            </div>
          </div>

          {/* Line editor */}
          <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            {!readOnly && (
              <div className="mb-4 flex flex-wrap items-start gap-3">
                <div className="relative flex-1 min-w-[16rem]">
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Add a product — search by SKU or name…"
                    className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
                  />
                  {isSearching && <div className="absolute right-3 top-2.5"><Spinner /></div>}
                  {results.length > 0 && (
                    <ul className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                      {results.map((r) => (
                        <li key={r.sku}>
                          <button
                            type="button"
                            onClick={() => pickSearchHit(r)}
                            className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-indigo-50"
                          >
                            <span>
                              <span className="font-medium text-slate-900">{r.name}</span>
                              <span className="ml-2 text-xs text-slate-400">{r.sku}</span>
                              {r.isService && <span className="ml-2 rounded-full bg-violet-100 px-1.5 py-0.5 text-[10px] font-semibold text-violet-700">service → charge</span>}
                            </span>
                            <span className="text-xs text-slate-500">{r.isService ? "added as charge" : r.averageCost == null ? "no cost" : `cost ${fmtMoney(r.averageCost)}`}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <button type="button" onClick={addChargeLine} className="rounded-full border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
                  + Add Line
                </button>
              </div>
            )}

            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-xs uppercase tracking-wide text-slate-400">
                    <th className="py-2 pr-3">Item</th>
                    <th className="py-2 px-2 text-right">Qty</th>
                    <th className="py-2 px-2 text-right">Unit price</th>
                    <th className="py-2 px-2 text-right">Disc %</th>
                    <th className="py-2 px-2 text-right">VAT %</th>
                    <th className="py-2 px-2 text-right">Net revenue</th>
                    <th className="py-2 px-2 text-right">Est. cost</th>
                    <th className="py-2 px-2 text-right">GP</th>
                    <th className="py-2 px-2 text-right">Margin</th>
                    <th className="py-2 pl-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.length === 0 ? (
                    <tr><td colSpan={10} className="py-8 text-center text-slate-400">No lines yet — search for a product above{!readOnly ? ", or add a charge" : ""}.</td></tr>
                  ) : (
                    lines.map((l, i) => {
                      const r = perLine[i];
                      const excludedCharge = l.lineType === "charge" && !l.marginIncluded;
                      return (
                        <tr key={l.uid} className="border-b border-slate-100">
                          <td className="py-1.5 pr-3">
                            {l.lineType === "charge" ? (
                              <div>
                                <input value={l.productName} onChange={(e) => updateLine(l.uid, { productName: e.target.value })} disabled={readOnly} placeholder="Charge description (e.g. Shipping)" className="w-full rounded border border-slate-200 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50" />
                                {readOnly ? (
                                  <div className="mt-1 text-xs text-slate-400">{l.marginIncluded ? "Included in margin" : "Excluded from margin"}</div>
                                ) : (
                                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-500">
                                    <label className="flex items-center gap-1"><input type="radio" name={`mt-${l.uid}`} checked={!l.marginIncluded} onChange={() => updateLine(l.uid, { marginIncluded: false })} /> Exclude from margin</label>
                                    <label className="flex items-center gap-1"><input type="radio" name={`mt-${l.uid}`} checked={l.marginIncluded} onChange={() => updateLine(l.uid, { marginIncluded: true })} /> Include</label>
                                    {l.marginIncluded && (
                                      <span className="flex items-center gap-1">
                                        <span>Est. cost R</span>
                                        <input value={l.estimatedCost} onChange={(e) => updateLine(l.uid, { estimatedCost: e.target.value })} inputMode="decimal" placeholder="0.00" className="w-20 rounded border border-slate-200 px-2 py-0.5 text-right text-xs focus:border-indigo-500 focus:outline-none" />
                                      </span>
                                    )}
                                    {l.marginIncluded && l.estimatedCost.trim() === "" && <span className="font-medium text-amber-600">enter a cost</span>}
                                  </div>
                                )}
                              </div>
                            ) : (
                              <div>
                                <div className="font-medium text-slate-900">{l.productName || l.productSku}</div>
                                <div className="text-xs text-slate-400">{l.productSku}{l.averageCost == null && <span className="ml-1 text-amber-600">· cost unavailable</span>}</div>
                              </div>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right"><input value={l.quantity} onChange={(e) => updateLine(l.uid, { quantity: e.target.value })} disabled={readOnly} inputMode="decimal" className="w-16 rounded border border-slate-200 px-2 py-1 text-right text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50" /></td>
                          <td className="py-1.5 px-2 text-right"><input value={l.unitPrice} onChange={(e) => updateLine(l.uid, { unitPrice: e.target.value })} disabled={readOnly} inputMode="decimal" className="w-24 rounded border border-slate-200 px-2 py-1 text-right text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50" /></td>
                          <td className="py-1.5 px-2 text-right"><input value={l.discountPct} onChange={(e) => updateLine(l.uid, { discountPct: e.target.value })} disabled={readOnly} inputMode="decimal" className="w-16 rounded border border-slate-200 px-2 py-1 text-right text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50" /></td>
                          <td className="py-1.5 px-2 text-right"><input value={l.taxRatePct} onChange={(e) => updateLine(l.uid, { taxRatePct: e.target.value })} disabled={readOnly} inputMode="decimal" className="w-16 rounded border border-slate-200 px-2 py-1 text-right text-sm focus:border-indigo-500 focus:outline-none disabled:bg-slate-50" /></td>
                          <td className="py-1.5 px-2 text-right tabular-nums">{fmtMoney(r.revenueExTax)}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-slate-500">{fmtMoney(r.estimatedCost)}</td>
                          <td className="py-1.5 px-2 text-right tabular-nums">{r.estimatedGP == null ? "—" : fmtMoney(r.estimatedGP)}</td>
                          <td className={`py-1.5 px-2 text-right tabular-nums font-medium ${excludedCharge ? "text-slate-400" : marginTone(r.marginPct)}`}>{excludedCharge ? "—" : fmtPct(r.marginPct)}</td>
                          <td className="py-1.5 pl-2 text-right">
                            {!readOnly && <button type="button" onClick={() => removeLine(l.uid)} className="text-slate-300 hover:text-red-500" aria-label="Remove line">✕</button>}
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>

            {/* Footer totals */}
            <div className="mt-6 flex flex-col items-end gap-1 border-t border-slate-200 pt-4 text-sm">
              <div className="flex w-full max-w-xs justify-between"><span className="text-slate-500">Subtotal (excl. VAT)</span><span className="tabular-nums">{fmtMoney(totals.subtotalExTax)}</span></div>
              <div className="flex w-full max-w-xs justify-between"><span className="text-slate-500">VAT</span><span className="tabular-nums">{fmtMoney(totals.taxTotal)}</span></div>
              <div className="flex w-full max-w-xs justify-between font-semibold text-slate-900"><span>Total (incl. VAT)</span><span className="tabular-nums">{fmtMoney(totals.totalIncTax)}</span></div>
              <div className="mt-2 flex w-full max-w-xs justify-between text-slate-500"><span>Estimated cost</span><span className="tabular-nums">{fmtMoney(totals.estimatedCost)}</span></div>
              <div className="flex w-full max-w-xs justify-between text-slate-500"><span>Estimated GP</span><span className="tabular-nums">{fmtMoney(totals.estimatedGP)}</span></div>
              <div className="flex w-full max-w-xs justify-between font-semibold"><span>{marginLabel}</span><span className={`tabular-nums ${marginTone(totals.overallMarginPct)}`}>{fmtPct(totals.overallMarginPct)}</span></div>
              {excludedChargeCount > 0 && (
                <p className="mt-1 max-w-xs text-right text-xs text-slate-500">
                  {excludedChargeCount === 1 ? "1 charge" : `${excludedChargeCount} charges`} excluded from margin (e.g. shipping).
                </p>
              )}
              {missingCostCount > 0 && (
                <p className="max-w-xs text-right text-xs text-amber-600">
                  {missingCostCount === 1 ? "1 line has" : `${missingCostCount} lines have`} no cost — margin incomplete.
                </p>
              )}
            </div>
          </div>

          {editorError && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{editorError}</p>}
          {saveMsg && <p className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">{saveMsg}</p>}

          {!readOnly && (
            <div className="flex items-center justify-between">
              <button type="button" onClick={removeQuote} disabled={isSaving || isSubmitting} className="text-sm text-red-500 hover:text-red-700 disabled:opacity-50">
                {quoteId ? "Delete draft" : "Discard"}
              </button>
              <div className="flex items-center gap-3">
                <button type="button" onClick={save} disabled={isSaving || isSubmitting} className="rounded-full border border-indigo-600 px-5 py-2 text-sm font-medium text-indigo-700 hover:bg-indigo-50 disabled:opacity-50">
                  {isSaving && <Spinner className="mr-1.5" />}
                  {isSaving ? "Saving…" : "Save draft"}
                </button>
                <button type="button" onClick={submitToCin7} disabled={isSaving || isSubmitting || !instanceId} className="rounded-full bg-emerald-600 px-5 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50">
                  {isSubmitting && <Spinner className="mr-1.5" />}
                  {isSubmitting ? "Submitting…" : "Submit to Cin7"}
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </main>
  );
}
