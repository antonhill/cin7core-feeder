"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { QUOTES_MODULE } from "@/app/module-nav";
import { searchQuoteCustomersAction, loadQuoteReferenceDataAction, type QuoteCustomerHit, type QuoteReferenceData } from "@/app/quotes/actions";
import { discoverGrowerProductsAction, lookupGrowerProductsAction } from "./actions";
import { calculateGrowerHouse } from "@/newquip/grower/calculate";
import { TOPIGS_GROWER_INPUT } from "@/newquip/grower/fixture";
import { resolveMapping, type MappingCandidate, type MappingResolution } from "@/newquip/grower/mapping";
import { buildBudgetQuote, type ProductCommercials } from "@/newquip/grower/quote-bridge";
import type { GeneratedLine, GrowerConfigurationInput, GrowerItemKey, OptionalItemKey, RuleStatus } from "@/newquip/grower/types";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { ModuleHeader } from "@/app/ModuleHeader";

// NewQuip Grower House configurator — INTERIM POC. READ-ONLY with respect to Cin7: it reads the synced
// catalogue and never saves or submits a quote. All engineering numbers come from the pure engine in
// src/newquip/grower; all money from the existing quote engine (via quote-bridge). Nothing here calculates.

const money = new Intl.NumberFormat("en-ZA", { style: "currency", currency: "ZAR" });
const fmtMoney = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "—" : money.format(n));
const fmtPct = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "N/A" : `${n.toFixed(1)}%`);

const STATUS_TONE: Record<RuleStatus, BadgeTone> = { verified: "success", provisional: "info", manual: "neutral", requires_validation: "warning" };
const STATUS_LABEL: Record<RuleStatus, string> = { verified: "Verified", provisional: "Provisional", manual: "Manual", requires_validation: "Requires NewQuip validation" };
const MAP_TONE = { MAPPED: "success", AMBIGUOUS: "warning", UNMAPPED: "neutral" } as const;

const OPTIONAL_LABELS: Record<OptionalItemKey, string> = {
  controller: "Thomas-CL1 controller",
  silo_weighing: "Silo weighing",
  control_panel: "Control panel",
  emergency_windows: "Emergency windows",
  pad_cooling: "Pad cooling",
  cone_fans: "Cone fans",
  manure_plug: "Manure plugs",
};

type NumField = "lengthM" | "widthM" | "rooms" | "totalPens" | "hospitalPens" | "pigsPerBuilding";

function NumInput({ label, value, onChange, unit }: { label: string; value: string; onChange: (v: string) => void; unit?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium text-slate-700">{label}{unit ? <span className="ml-1 font-normal text-slate-400">({unit})</span> : null}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm tabular-nums text-slate-900" />
    </label>
  );
}

export default function NewquipGrowerPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  // --- project context ---
  const [customerName, setCustomerName] = useState("");
  const [custResults, setCustResults] = useState<QuoteCustomerHit[]>([]);
  const [showCust, setShowCust] = useState(false);
  const [project, setProject] = useState("");
  const [priceTier, setPriceTier] = useState("");
  const [refData, setRefData] = useState<QuoteReferenceData>({ locations: [], priceTiers: [], salesReps: [], taxRules: [] });
  const [, startTransition] = useTransition();

  useEffect(() => {
    const q = customerName.trim();
    const t = setTimeout(() => {
      if (q.length < 2) return setCustResults([]);
      startTransition(async () => {
        const res = await searchQuoteCustomersAction(q);
        setCustResults(res.ok ? res.data ?? [] : []);
      });
    }, 250);
    return () => clearTimeout(t);
  }, [customerName]);

  useEffect(() => {
    if (!instanceId) return;
    startTransition(async () => {
      const res = await loadQuoteReferenceDataAction(instanceId);
      if (res.ok && res.data) setRefData(res.data);
    });
  }, [instanceId]);

  // --- configuration (strings so inputs can be mid-typing) ---
  const g = TOPIGS_GROWER_INPUT;
  const [nums, setNums] = useState<Record<NumField, string>>({
    lengthM: String(g.lengthM), widthM: String(g.widthM), rooms: String(g.rooms),
    totalPens: String(g.totalPens), hospitalPens: String(g.hospitalPens), pigsPerBuilding: String(g.pigsPerBuilding),
  });
  const [optional, setOptional] = useState<Record<OptionalItemKey, boolean>>(g.optionalEquipment);
  const [overrides, setOverrides] = useState<Partial<Record<GrowerItemKey, string>>>({});
  const setNum = (k: NumField) => (v: string) => setNums((p) => ({ ...p, [k]: v }));

  const input: GrowerConfigurationInput = useMemo(() => {
    const ov: Partial<Record<GrowerItemKey, number>> = {};
    for (const [k, v] of Object.entries(overrides)) if (v != null && v.trim() !== "") ov[k as GrowerItemKey] = Number(v);
    return {
      ...g,
      lengthM: Number(nums.lengthM), widthM: Number(nums.widthM), rooms: Number(nums.rooms),
      totalPens: Number(nums.totalPens), hospitalPens: Number(nums.hospitalPens), pigsPerBuilding: Number(nums.pigsPerBuilding),
      optionalEquipment: optional,
      quantityOverrides: ov,
    };
  }, [g, nums, optional, overrides]);

  const result = useMemo(() => calculateGrowerHouse(input), [input]);

  // --- product mapping + commercials (read-only lookups) ---
  const [candidates, setCandidates] = useState<Record<string, MappingCandidate[]>>({});
  const [confirmed, setConfirmed] = useState<Partial<Record<GrowerItemKey, string>>>({});
  const [products, setProducts] = useState<Map<string, ProductCommercials>>(new Map());
  const [lookupError, setLookupError] = useState<string | null>(null);

  useEffect(() => {
    startTransition(async () => {
      const res = await discoverGrowerProductsAction();
      if (res.ok && res.data) setCandidates(res.data);
      else setLookupError(res.error ?? "Product discovery failed.");
    });
  }, []);

  const confirmedKey = JSON.stringify(Object.values(confirmed).filter(Boolean).sort());
  useEffect(() => {
    const skus = JSON.parse(confirmedKey) as string[];
    if (skus.length === 0) return;
    startTransition(async () => {
      const res = await lookupGrowerProductsAction(skus);
      if (res.ok && res.data) setProducts(new Map(res.data.map((p) => [p.sku, p])));
      else setLookupError(res.error ?? "Product lookup failed.");
    });
  }, [confirmedKey]);

  const mappings = useMemo(() => {
    const catalogue = new Set([...products.keys()]);
    const m = new Map<string, MappingResolution>();
    for (const l of result.lines) m.set(l.itemKey, resolveMapping(l.itemKey, candidates[l.itemKey] ?? [], confirmed[l.itemKey] ?? null, catalogue));
    return m;
  }, [result.lines, candidates, confirmed, products]);

  const tierCode = (() => {
    const c = refData.priceTiers.find((t) => t.name === priceTier)?.code;
    return c != null ? `Tier${c}` : null;
  })();
  const taxRatePct = refData.taxRules.find((r) => /standard/i.test(r.name))?.rate ?? 0;

  const budget = useMemo(
    () => buildBudgetQuote(result.lines, mappings, products, { tierCode, taxRatePct, taxInclusive: false }),
    [result.lines, mappings, products, tierCode, taxRatePct],
  );
  const bridgeBy = new Map(budget.lines.map((l) => [l.itemKey, l]));
  const [open, setOpen] = useState<GrowerItemKey | null>(null);

  return (
    <main className="mx-auto w-full max-w-[96rem] px-6 py-12">
      <ModuleHeader module={{ ...QUOTES_MODULE, label: "NewQuip Grower House" }}>
        Interim POC — configure a Grower House and see the generated bill of materials priced from Cin7. Quantities appear only where the rule is validated; everything else shows its historic Topigs reference and awaits NewQuip.
      </ModuleHeader>

      <div className="mt-4 flex flex-col gap-2">
        <Alert tone="warning">Budget preview only — read-only. Nothing is saved or sent to Cin7. Engineering rules marked “awaiting validation” are NOT confirmed by NewQuip.</Alert>
        {lookupError && <Alert tone="danger">{lookupError}</Alert>}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[26rem_1fr]">
        {/* LEFT: configuration */}
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelTitle>Project</PanelTitle>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Instance</span><InstancePicker {...picker} onChange={picker.setInstanceId} /></label>
              <label className="relative flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Customer</span>
                <input value={customerName} onChange={(e) => { setCustomerName(e.target.value); setShowCust(true); }} onBlur={() => setTimeout(() => setShowCust(false), 150)} placeholder="Search customers…" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm" />
                {showCust && custResults.length > 0 && (
                  <ul className="absolute top-full z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                    {custResults.map((c) => (
                      <li key={c.name}><button type="button" onMouseDown={(e) => { e.preventDefault(); setCustomerName(c.name); if (c.priceTier) setPriceTier(c.priceTier); setShowCust(false); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-primary-subtle">{c.name}</button></li>
                    ))}
                  </ul>
                )}
              </label>
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Project / reference</span><input value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. AS.23.4015.07" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm" /></label>
              <Select label="Price tier" value={priceTier} onChange={(e) => setPriceTier(e.target.value)} disabled={!instanceId}>
                <option value="">Choose a price tier</option>
                {refData.priceTiers.map((t) => <option key={t.code} value={t.name}>{t.name}</option>)}
              </Select>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>Building &amp; pens</PanelTitle>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <NumInput label="Length" unit="m" value={nums.lengthM} onChange={setNum("lengthM")} />
              <NumInput label="Width" unit="m" value={nums.widthM} onChange={setNum("widthM")} />
              <NumInput label="Rooms" value={nums.rooms} onChange={setNum("rooms")} />
              <NumInput label="Pigs / building" value={nums.pigsPerBuilding} onChange={setNum("pigsPerBuilding")} />
              <NumInput label="Total pens" value={nums.totalPens} onChange={setNum("totalPens")} />
              <NumInput label="Hospital / split pens" value={nums.hospitalPens} onChange={setNum("hospitalPens")} />
            </div>
            <p className="mt-3 text-xs text-slate-500">Floor area (verified: length × width): <span className="font-medium tabular-nums text-slate-700">{result.derived.floorAreaM2 == null ? "—" : `${result.derived.floorAreaM2.toFixed(3)} m²`}</span></p>
          </Panel>

          <Panel>
            <PanelTitle>Equipment selection</PanelTitle>
            <dl className="mt-3 grid grid-cols-[7rem_1fr] gap-y-1.5 text-sm">
              <dt className="text-slate-500">Feeding</dt><dd>CCM feeder · M75 Flex · 13.39t tank</dd>
              <dt className="text-slate-500">Drinking</dt><dd>Grower cup drinker</dd>
              <dt className="text-slate-500">Flooring</dt><dd>Concrete slat 1.2 × 0.45 m</dd>
              <dt className="text-slate-500">Penning</dt><dd>PP Green 50 mm × 0.9 m vented</dd>
              <dt className="text-slate-500">Lighting</dt><dd>FORTIS 1.2 5000K LED</dd>
            </dl>
            <p className="mt-2 text-xs text-slate-400">The POC supports only the Topigs Grower selections; alternatives need rules from NewQuip.</p>
          </Panel>

          <Panel>
            <PanelTitle>Optional equipment</PanelTitle>
            <div className="mt-3 grid gap-2">
              {(Object.keys(OPTIONAL_LABELS) as OptionalItemKey[]).map((k) => (
                <Checkbox key={k} label={OPTIONAL_LABELS[k]} checked={optional[k]} onChange={(e) => setOptional((p) => ({ ...p, [k]: e.target.checked }))} />
              ))}
            </div>
          </Panel>
        </div>

        {/* RIGHT: generated BOM + budget */}
        <div className="flex flex-col gap-4">
          {!result.valid && <Alert tone="danger">{result.issues.map((i) => i.message).join(" ")}</Alert>}
          <Panel>
            <PanelTitle>Generated bill of materials — per room × {Number.isFinite(input.rooms) ? input.rooms : "?"} rooms</PanelTitle>
            <div className="mt-3 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b-2 border-slate-300 text-xs font-semibold uppercase tracking-wide text-slate-600">
                    <th className="py-2 pr-3">Item</th><th className="px-2">Rule</th><th className="px-2 text-right">Qty / room</th>
                    <th className="px-2 text-right">Override</th><th className="px-2">Cin7 product</th><th className="px-2 text-right">Unit</th><th className="px-2 text-right">Net</th><th className="px-2 text-right">Margin</th>
                  </tr>
                </thead>
                <tbody>
                  {result.lines.map((l: GeneratedLine) => {
                    const b = bridgeBy.get(l.itemKey);
                    const m = mappings.get(l.itemKey);
                    return (
                      <LineRows key={l.itemKey} l={l} b={b} m={m} isOpen={open === l.itemKey} toggle={() => setOpen(open === l.itemKey ? null : l.itemKey)}
                        override={overrides[l.itemKey] ?? ""} setOverride={(v) => setOverrides((p) => ({ ...p, [l.itemKey]: v }))}
                        useHistoric={() => setOverrides((p) => ({ ...p, [l.itemKey]: String(l.historicReference.quantityPerRoom ?? "") }))}
                        sku={confirmed[l.itemKey] ?? ""} setSku={(v) => setConfirmed((p) => ({ ...p, [l.itemKey]: v.trim() }))} candidates={candidates[l.itemKey] ?? []} />
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>Budget preview</PanelTitle>
            <div className="mt-3 grid max-w-sm gap-1 text-sm">
              <Row k="Selling subtotal (excl. VAT)" v={fmtMoney(budget.totals.subtotalExTax)} />
              <Row k={`VAT (${taxRatePct}%)`} v={fmtMoney(budget.totals.taxTotal)} />
              <Row k="Total (incl. VAT)" v={fmtMoney(budget.totals.totalIncTax)} bold />
              <Row k="Estimated cost" v={fmtMoney(budget.totals.estimatedCost)} />
              <Row k="Estimated GP" v={fmtMoney(budget.totals.estimatedGP)} />
              <Row k="Estimated overall margin" v={fmtPct(budget.totals.overallMarginPct)} bold />
            </div>
            {budget.incomplete && (
              <div className="mt-4"><Alert tone="warning">
                <span className="font-medium">This budget is INCOMPLETE — totals cover priced lines only.</span>
                <ul className="mt-1 list-disc pl-5 text-xs">{budget.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
              </Alert></div>
            )}
            <div className="mt-4"><Button variant="secondary" disabled>Save / submit — not available in this POC</Button></div>
          </Panel>
        </div>
      </div>
    </main>
  );
}

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return <div className={`flex justify-between ${bold ? "font-semibold text-slate-900" : "text-slate-600"}`}><span>{k}</span><span className="tabular-nums">{v}</span></div>;
}

function LineRows(p: {
  l: GeneratedLine; b: ReturnType<typeof buildBudgetQuote>["lines"][number] | undefined; m: MappingResolution | undefined;
  isOpen: boolean; toggle: () => void; override: string; setOverride: (v: string) => void; useHistoric: () => void;
  sku: string; setSku: (v: string) => void; candidates: MappingCandidate[];
}) {
  const { l, b, m } = p;
  const listId = `cand-${l.itemKey}`;
  return (
    <>
      <tr className="border-b border-slate-100 align-top">
        <td className="py-2 pr-3">
          <div className="font-medium text-slate-900">{l.label}</div>
          <button type="button" onClick={p.toggle} className="text-xs text-primary hover:underline">{p.isOpen ? "Hide why" : "Why?"}</button>
        </td>
        <td className="px-2 py-2"><div className="flex flex-col gap-1"><Badge tone={STATUS_TONE[l.ruleStatus]}>{STATUS_LABEL[l.ruleStatus]}</Badge><span className="text-xs text-slate-400">{l.ruleId}</span></div></td>
        <td className="px-2 py-2 text-right">
          {l.quantityPerRoom != null ? (
            <div><span className="font-semibold tabular-nums">{l.quantityPerRoom}</span><div className="text-xs text-slate-400">{l.basis === "manual_override" ? "MANUAL" : l.basis === "not_selected" ? "not selected" : "SYSTEM CALCULATED"}</div></div>
          ) : (
            <div className="text-xs text-warning">Rule awaiting NewQuip validation
              <div className="text-slate-500">HISTORIC REFERENCE: {l.historicReference.quantityPerRoom ?? "—"}</div></div>
          )}
        </td>
        <td className="px-2 py-2 text-right">
          {l.basis !== "not_selected" && (
            <div className="flex flex-col items-end gap-1">
              <input value={p.override} onChange={(e) => p.setOverride(e.target.value)} inputMode="decimal" placeholder="manual qty" className="w-20 rounded border border-slate-200 px-2 py-1 text-right text-xs" />
              {l.historicReference.quantityPerRoom != null && p.override === "" && <button type="button" onClick={p.useHistoric} className="text-xs text-slate-500 hover:text-slate-800">use historic</button>}
            </div>
          )}
        </td>
        <td className="px-2 py-2">
          {m && <Badge tone={MAP_TONE[m.status]}>{m.status}</Badge>}
          <input value={p.sku} onChange={(e) => p.setSku(e.target.value)} list={listId} placeholder="confirm SKU" className="mt-1 block w-32 rounded border border-slate-200 px-2 py-1 text-xs" />
          <datalist id={listId}>{p.candidates.map((c) => <option key={c.sku} value={c.sku}>{c.name}</option>)}</datalist>
          {m?.status === "AMBIGUOUS" && <div className="mt-1 max-w-[10rem] text-xs text-warning">REQUIRES NEWQUIP SKU CONFIRMATION</div>}
        </td>
        <td className="px-2 py-2 text-right tabular-nums">{fmtMoney(b?.unitPrice)}</td>
        <td className="px-2 py-2 text-right tabular-nums">{b?.status === "priced" ? fmtMoney(b.revenueExTax) : <span className="text-xs text-slate-400">{b?.status === "not_selected" ? "—" : "not priced"}</span>}</td>
        <td className="px-2 py-2 text-right tabular-nums">{b?.status === "priced" ? (b.costMissing ? <span className="text-xs text-warning">no cost</span> : fmtPct(b.marginPct)) : "—"}</td>
      </tr>
      {p.isOpen && (
        <tr className="border-b border-slate-100 bg-slate-50">
          <td colSpan={8} className="px-3 py-3">
            <div className="text-sm font-medium text-slate-800">{l.explanation.headline}</div>
            <ul className="mt-1 list-disc pl-5 text-xs text-slate-600">{l.explanation.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
            {b && b.status !== "priced" && b.status !== "not_selected" && <p className="mt-2 text-xs text-warning">Pricing: {b.reason}</p>}
          </td>
        </tr>
      )}
    </>
  );
}
