"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useInstancePicker } from "@/hooks/useInstancePicker";
import { InstancePicker } from "@/app/InstancePicker";
import { QUOTES_MODULE } from "@/app/module-nav";
import {
  searchQuoteCustomersAction,
  loadQuoteReferenceDataAction,
  resolveQuoteCustomerAction,
  getProductTierPricesAction,
  type QuoteCustomerHit,
  type QuoteReferenceData,
} from "@/app/quotes/actions";
import { discoverGrowerProductsAction, lookupGrowerProductsAction } from "./actions";
import { calculateGrowerHouse } from "@/newquip/grower/calculate";
import { TOPIGS_GROWER_INPUT } from "@/newquip/grower/fixture";
import { GROWER_RULES } from "@/newquip/grower/rules";
import { resolveVat } from "@/newquip/grower/tax";
import { splitBomLines, quantityProvenance } from "@/newquip/grower/bom-view";
import { resolveMapping, type MappingCandidate, type MappingResolution } from "@/newquip/grower/mapping";
import { buildBudgetQuote, type BridgeLine, type BudgetQuote, type ProductCommercials } from "@/newquip/grower/quote-bridge";
import type { GeneratedLine, GrowerConfigurationInput, GrowerItemKey, OptionalItemKey, RuleStatus } from "@/newquip/grower/types";
import { Panel, PanelTitle } from "@/components/ui/Panel";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { Checkbox } from "@/components/ui/Checkbox";
import { ModuleHeader } from "@/app/ModuleHeader";

// NewQuip Grower House configurator — INTERIM POC. READ-ONLY with respect to Cin7: it reads the synced
// catalogue (and the Quotes module's existing live tier-price read) and never saves or submits a quote.
// All engineering numbers come from the pure engine in src/newquip/grower; all money from the existing
// quote engine (via quote-bridge); VAT from the customer's Cin7 tax rule (tax.ts). Nothing here calculates.

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

/** Short, human reason a line has no money yet (the Why panel has the detail). */
const BRIDGE_SHORT: Record<BridgeLine["status"], string> = {
  priced: "",
  no_quantity: "Awaiting quantity",
  not_selected: "",
  unmapped: "Awaiting product",
  product_missing: "Product unavailable",
  no_price: "Awaiting price",
};

type NumField = "lengthM" | "widthM" | "rooms" | "totalPens" | "hospitalPens" | "pigsPerBuilding";
type OverrideSource = "historic" | "typed";

function NumInput({ label, value, onChange, unit, title }: { label: string; value: string; onChange: (v: string) => void; unit?: string; title?: string }) {
  return (
    <label className="flex flex-col gap-1 text-sm" title={title}>
      <span className="font-medium text-slate-700">{label}{unit ? <span className="ml-1 font-normal text-slate-400">({unit})</span> : null}</span>
      <input value={value} onChange={(e) => onChange(e.target.value)} inputMode="decimal" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm tabular-nums text-slate-900" />
    </label>
  );
}

function candidateLabel(c: MappingCandidate): string {
  const bits = [c.sku, c.name];
  const extra = [c.averageCost != null ? `cost ${fmtMoney(c.averageCost)}` : "no cost", c.available != null ? `${c.available} avail` : null].filter(Boolean);
  return `${bits.join(" — ")}  ·  ${extra.join(" · ")}`;
}

export default function NewquipGrowerPage() {
  const picker = useInstancePicker();
  const { instanceId } = picker;

  // --- project context ---
  const [customerName, setCustomerName] = useState("");
  const [customerTaxRule, setCustomerTaxRule] = useState<string | null>(null);
  const [custResults, setCustResults] = useState<QuoteCustomerHit[]>([]);
  const [showCust, setShowCust] = useState(false);
  const [project, setProject] = useState("");
  const [priceTier, setPriceTier] = useState("");
  const [refData, setRefData] = useState<QuoteReferenceData>({ locations: [], priceTiers: [], salesReps: [], taxRules: [] });
  const [refLoaded, setRefLoaded] = useState(false);
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
      setRefLoaded(true);
    });
  }, [instanceId]);

  function pickCustomer(c: QuoteCustomerHit) {
    setCustomerName(c.name);
    setCustomerTaxRule(c.taxRule);
    if (c.priceTier) setPriceTier(c.priceTier);
    setShowCust(false);
    if (!instanceId) return;
    // Same as the Quotes builder: refresh the customer's defaults LIVE from Cin7 (read-only lookup).
    startTransition(async () => {
      const res = await resolveQuoteCustomerAction(instanceId, c.name);
      if (res.ok && res.data) {
        if (res.data.taxRule) setCustomerTaxRule(res.data.taxRule);
        if (res.data.priceTier) setPriceTier(res.data.priceTier);
      }
    });
  }

  const vat = useMemo(() => resolveVat(customerTaxRule, refData.taxRules), [customerTaxRule, refData.taxRules]);
  const taxRatePct = vat.status === "resolved" ? vat.ratePct : 0;

  // --- configuration (strings so inputs can be mid-typing) ---
  const g = TOPIGS_GROWER_INPUT;
  const [nums, setNums] = useState<Record<NumField, string>>({
    lengthM: String(g.lengthM), widthM: String(g.widthM), rooms: String(g.rooms),
    totalPens: String(g.totalPens), hospitalPens: String(g.hospitalPens), pigsPerBuilding: String(g.pigsPerBuilding),
  });
  const [optional, setOptional] = useState<Record<OptionalItemKey, boolean>>(g.optionalEquipment);
  const [overrides, setOverrides] = useState<Partial<Record<GrowerItemKey, string>>>({});
  const [overrideSource, setOverrideSource] = useState<Partial<Record<GrowerItemKey, OverrideSource>>>({});
  const setNum = (k: NumField) => (v: string) => setNums((p) => ({ ...p, [k]: v }));
  const setOverride = (k: GrowerItemKey, v: string, src: OverrideSource) => {
    setOverrides((p) => ({ ...p, [k]: v }));
    setOverrideSource((p) => ({ ...p, [k]: src }));
  };

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
  // Optional equipment that isn't selected stays out of the primary BOM (its definition and rule are untouched).
  const { primary: bomLines, optionalNotSelected: optionalOffCount } = useMemo(() => splitBomLines(result.lines), [result.lines]);

  // --- product mapping + commercials (read-only lookups) ---
  const [candidates, setCandidates] = useState<Record<string, MappingCandidate[]>>({});
  const [confirmed, setConfirmed] = useState<Partial<Record<GrowerItemKey, string>>>({});
  const [products, setProducts] = useState<Map<string, ProductCommercials>>(new Map());
  const [liveTiers, setLiveTiers] = useState<Record<string, Record<string, number>>>({});
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

  // The synced price_tiers table only keeps non-zero tiers and can be empty; reuse the Quotes module's
  // existing LIVE per-SKU tier read (read-only GET) for confirmed products.
  useEffect(() => {
    const skus = JSON.parse(confirmedKey) as string[];
    if (!instanceId || skus.length === 0) return;
    startTransition(async () => {
      const entries = await Promise.all(skus.map(async (sku) => [sku, await getProductTierPricesAction(instanceId, sku)] as const));
      const next: Record<string, Record<string, number>> = {};
      for (const [sku, r] of entries) if (r.ok && r.data && Object.keys(r.data).length > 0) next[sku] = r.data;
      setLiveTiers(next);
    });
  }, [confirmedKey, instanceId]);

  const commercials = useMemo(() => {
    const m = new Map<string, ProductCommercials>();
    for (const [sku, p] of products) m.set(sku, { ...p, tierPrices: liveTiers[sku] ?? p.tierPrices });
    return m;
  }, [products, liveTiers]);

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

  const budget = useMemo(
    () => buildBudgetQuote(result.lines, mappings, commercials, { tierCode, taxRatePct, taxInclusive: false }),
    [result.lines, mappings, commercials, tierCode, taxRatePct],
  );
  const bridgeBy = new Map(budget.lines.map((l) => [l.itemKey, l]));
  const [open, setOpen] = useState<GrowerItemKey | null>(null);
  const noTiers = refLoaded && refData.priceTiers.length === 0;

  return (
    <main className="mx-auto w-full max-w-[96rem] px-6 py-12">
      <ModuleHeader module={{ ...QUOTES_MODULE, label: "NewQuip Grower House" }}>
        Interim POC — configure a Grower House and see the generated bill of materials priced from Cin7. Quantities appear only where the rule is validated; everything else shows its historic Topigs reference and awaits NewQuip.
      </ModuleHeader>

      <div className="mt-4 flex flex-col gap-2">
        <Alert tone="warning">Budget preview only — read-only. Nothing is saved or sent to Cin7. Engineering rules marked “awaiting validation” are NOT confirmed by NewQuip.</Alert>
        {lookupError && <Alert tone="danger">{lookupError}</Alert>}
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[24rem_1fr]">
        {/* LEFT: configuration */}
        <div className="flex flex-col gap-4">
          <Panel>
            <PanelTitle>Project</PanelTitle>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Instance</span><InstancePicker {...picker} onChange={picker.setInstanceId} /></label>
              <label className="relative flex flex-col gap-1 text-sm">
                <span className="font-medium text-slate-700">Customer</span>
                <input value={customerName} onChange={(e) => { setCustomerName(e.target.value); setCustomerTaxRule(null); setShowCust(true); }} onBlur={() => setTimeout(() => setShowCust(false), 150)} placeholder="Search customers…" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm" />
                {showCust && custResults.length > 0 && (
                  <ul className="absolute top-full z-10 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-slate-200 bg-white shadow-lg">
                    {custResults.map((c) => (
                      <li key={c.name}><button type="button" onMouseDown={(e) => { e.preventDefault(); pickCustomer(c); }} className="block w-full px-3 py-2 text-left text-sm hover:bg-primary-subtle">{c.name}</button></li>
                    ))}
                  </ul>
                )}
              </label>
              <label className="flex flex-col gap-1 text-sm"><span className="font-medium text-slate-700">Project / reference</span><input value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. AS.23.4015.07" className="h-9 rounded-md border border-slate-300 bg-white px-3 text-sm" /></label>
              {!instanceId ? (
                <p className="text-sm text-slate-500"><span className="font-medium text-slate-700">Selling price:</span> choose an instance to load Cin7 price tiers.</p>
              ) : noTiers ? (
                <p className="text-sm text-warning"><span className="font-medium">Selling price:</span> No Cin7 price tier currently available.</p>
              ) : (
                <Select label="Price tier" value={priceTier} onChange={(e) => setPriceTier(e.target.value)} disabled={!refLoaded}>
                  <option value="">{refLoaded ? "Choose a price tier" : "Loading…"}</option>
                  {refData.priceTiers.map((t) => <option key={t.code} value={t.name}>{t.name}</option>)}
                </Select>
              )}
              <p className="text-xs text-slate-500">
                VAT:{" "}
                {vat.status === "resolved" ? <span className="font-medium text-slate-700">{vat.ratePct}% — {vat.ruleName} (customer’s Cin7 tax rule)</span>
                  : vat.status === "rule_not_found" ? <span className="text-warning">customer rule “{vat.ruleName}” not found in Cin7 tax rules</span>
                  : "choose a customer to apply their Cin7 tax rule"}
              </p>
            </div>
          </Panel>

          <Panel>
            <PanelTitle>Building &amp; pens</PanelTitle>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <NumInput label="Length" unit="m" value={nums.lengthM} onChange={setNum("lengthM")} />
              <NumInput label="Width" unit="m" value={nums.widthM} onChange={setNum("widthM")} />
              <NumInput label="Rooms" value={nums.rooms} onChange={setNum("rooms")} title="Source-workbook term; its exact meaning is awaiting NewQuip confirmation." />
              <NumInput label="Pigs / building" value={nums.pigsPerBuilding} onChange={setNum("pigsPerBuilding")} />
              <NumInput label="Total pens" value={nums.totalPens} onChange={setNum("totalPens")} />
              <NumInput label="Hospital / split pens" value={nums.hospitalPens} onChange={setNum("hospitalPens")} />
            </div>
            <p className="mt-3 text-xs text-slate-500">Floor area (verified: length × width): <span className="font-medium tabular-nums text-slate-700">{result.derived.floorAreaM2 == null ? "—" : `${result.derived.floorAreaM2.toFixed(3)} m²`}</span></p>
          </Panel>

          <Panel>
            <PanelTitle>Equipment selection</PanelTitle>
            <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1.5 text-sm">
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
            <div className="flex items-baseline justify-between">
              <PanelTitle>Generated bill of materials</PanelTitle>
              <span className="text-xs text-slate-500">Reference multiplier: ×{Number.isFinite(input.rooms) ? input.rooms : "?"}</span>
            </div>
            <ul className="mt-3 divide-y divide-slate-100">
              {bomLines.map((l) => (
                <BomRow
                  key={l.itemKey}
                  l={l}
                  b={bridgeBy.get(l.itemKey)}
                  m={mappings.get(l.itemKey)}
                  isOpen={open === l.itemKey}
                  toggle={() => setOpen(open === l.itemKey ? null : l.itemKey)}
                  override={overrides[l.itemKey] ?? ""}
                  source={overrideSource[l.itemKey]}
                  setOverride={(v) => setOverride(l.itemKey, v, "typed")}
                  clearOverride={() => { setOverrides((p) => ({ ...p, [l.itemKey]: "" })); setOverrideSource((p) => ({ ...p, [l.itemKey]: undefined })); }}
                  useTopigs={() => setOverride(l.itemKey, String(l.historicReference.quantityPerRoom ?? ""), "historic")}
                  sku={confirmed[l.itemKey] ?? ""}
                  setSku={(v) => setConfirmed((p) => ({ ...p, [l.itemKey]: v || undefined }))}
                  rooms={input.rooms}
                />
              ))}
            </ul>
            {optionalOffCount > 0 && <p className="mt-3 text-xs text-slate-400">{optionalOffCount} optional item{optionalOffCount === 1 ? "" : "s"} not selected — switch them on under Optional equipment.</p>}
          </Panel>

          <BudgetPanel budget={budget} taxRatePct={taxRatePct} vatResolved={vat.status === "resolved"} totalLines={bomLines.length} />
        </div>
      </div>
    </main>
  );
}

function BudgetPanel({ budget, taxRatePct, vatResolved, totalLines }: { budget: BudgetQuote; taxRatePct: number; vatResolved: boolean; totalLines: number }) {
  const t = budget.totals;
  return (
    <Panel>
      <div className="flex items-center justify-between">
        <PanelTitle>Budget preview</PanelTitle>
        <Badge tone={budget.state === "complete" ? "success" : "warning"}>
          {budget.state === "complete" ? "Complete" : budget.state === "partial" ? "Incomplete — partial total" : "Incomplete — awaiting pricing"}
        </Badge>
      </div>

      {budget.state === "awaiting_pricing" ? (
        <p className="mt-3 text-sm text-slate-600">No current selling price available yet. Totals appear once at least one line has a quantity, a confirmed Cin7 product and a selling price.</p>
      ) : (
        <>
          {budget.state === "partial" && (
            <p className="mt-3 text-sm text-slate-600">Priced lines only — {budget.pricedLineCount} of {totalLines} lines. This is not a total for the whole house.</p>
          )}
          <div className="mt-3 grid max-w-sm gap-1 text-sm">
            <Row k={budget.state === "partial" ? "Partial subtotal (excl. VAT)" : "Subtotal (excl. VAT)"} v={fmtMoney(t.subtotalExTax)} />
            <Row k={vatResolved ? `VAT (${taxRatePct}%)` : "VAT"} v={vatResolved ? fmtMoney(t.taxTotal) : "choose a customer"} />
            <Row k={budget.state === "partial" ? "Partial total (incl. VAT)" : "Total (incl. VAT)"} v={vatResolved ? fmtMoney(t.totalIncTax) : "—"} bold />
            <Row k="Estimated cost" v={fmtMoney(t.estimatedCost)} />
            <Row k="Estimated GP" v={fmtMoney(t.estimatedGP)} />
            <Row k="Estimated overall margin" v={fmtPct(t.overallMarginPct)} bold />
          </div>
        </>
      )}

      {budget.blockers.length > 0 && (
        <details className="mt-4 text-xs text-slate-600">
          <summary className="cursor-pointer font-medium text-warning">{budget.blockers.length} thing{budget.blockers.length === 1 ? "" : "s"} still needed</summary>
          <ul className="mt-1 list-disc pl-5">{budget.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
        </details>
      )}
      <div className="mt-4"><Button variant="secondary" disabled>Save / submit — not available in this POC</Button></div>
    </Panel>
  );
}

function Row({ k, v, bold }: { k: string; v: string; bold?: boolean }) {
  return <div className={`flex justify-between ${bold ? "font-semibold text-slate-900" : "text-slate-600"}`}><span>{k}</span><span className="tabular-nums">{v}</span></div>;
}

function BomRow(p: {
  l: GeneratedLine; b: BridgeLine | undefined; m: MappingResolution | undefined; isOpen: boolean; toggle: () => void;
  override: string; source: OverrideSource | undefined; setOverride: (v: string) => void; clearOverride: () => void; useTopigs: () => void;
  sku: string; setSku: (v: string) => void; rooms: number;
}) {
  const { l, b, m } = p;
  const def = GROWER_RULES.find((d) => d.id === l.ruleId);
  const hist = l.historicReference.quantityPerRoom;
  const prov = quantityProvenance(l, p.source);
  const manual = prov === "manual_topigs_reference" || prov === "manual_entry";
  const chosen = m?.candidates.find((c) => c.sku === p.sku);

  return (
    <li className="py-3">
      <div className="grid items-start gap-x-6 gap-y-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1.3fr)_minmax(0,0.6fr)]">
        {/* Item + calculation state */}
        <div>
          <div className="font-medium text-slate-900">{l.label}</div>
          <div className="mt-1 space-y-0.5 text-xs">
            {manual ? (
              <>
                <div className="flex items-center gap-2">
                  <Badge tone="neutral">{prov === "manual_topigs_reference" ? "MANUAL / HISTORIC REFERENCE" : "MANUAL"}</Badge>
                  <span className="font-semibold tabular-nums text-slate-800">{l.quantityPerRoom}</span>
                </div>
                <div className="text-slate-500">{prov === "manual_topigs_reference" ? "Topigs reference quantity — not a verified calculation" : "Estimator entry — not a verified calculation"}</div>
              </>
            ) : prov === "verified_calculation" ? (
              <div className="text-slate-700">Calculated: <span className="font-semibold tabular-nums">{l.quantityPerRoom}</span> <span className="text-slate-400">· {STATUS_LABEL[l.ruleStatus]}</span></div>
            ) : (
              <>
                <div className="text-slate-500">Historic reference: <span className="font-medium tabular-nums text-slate-700">{hist ?? "—"}</span>{hist != null ? " / unit" : ""}</div>
                <div className="text-warning">Calculation: awaiting validation</div>
              </>
            )}
          </div>
        </div>

        {/* Product */}
        <div className="text-xs">
          {m?.status === "UNMAPPED" ? (
            <div className="text-slate-500">Product: no matching Cin7 product found</div>
          ) : (
            <>
              <select
                value={p.sku}
                onChange={(e) => p.setSku(e.target.value)}
                aria-label={`Cin7 product for ${l.label}`}
                className="h-8 w-full rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-900"
              >
                <option value="">{(m?.candidates.length ?? 0) === 1 ? "1 Cin7 candidate — select to confirm" : `${m?.candidates.length ?? 0} Cin7 candidates — select product`}</option>
                {(m?.candidates ?? []).map((c) => <option key={c.sku} value={c.sku}>{candidateLabel(c)}</option>)}
              </select>
              <div className="mt-1 flex items-center gap-2">
                {m && <Badge tone={MAP_TONE[m.status]}>{m.status === "MAPPED" ? "Confirmed" : m.status === "AMBIGUOUS" ? "Needs confirmation" : "Unmapped"}</Badge>}
                {chosen && <span className="truncate text-slate-500">{chosen.sku}</span>}
              </div>
            </>
          )}
        </div>

        {/* Commercial + actions */}
        <div className="text-right text-xs">
          {b?.status === "priced" ? (
            <div>
              <div className="text-sm font-semibold tabular-nums text-slate-900">{fmtMoney(b.revenueExTax)}</div>
              <div className="text-slate-500">{b.costMissing ? <span className="text-warning">no cost</span> : `margin ${fmtPct(b.marginPct)}`}</div>
            </div>
          ) : (
            <div className="text-slate-400">{b ? BRIDGE_SHORT[b.status] : ""}</div>
          )}
          <div className="mt-1 flex justify-end gap-3">
            {!manual && hist != null && <button type="button" onClick={p.useTopigs} className="text-slate-500 hover:text-slate-800">Use Topigs reference qty</button>}
            {manual && <button type="button" onClick={p.clearOverride} className="text-slate-500 hover:text-slate-800">Clear</button>}
            <button type="button" onClick={p.toggle} className="text-primary hover:underline">{p.isOpen ? "Hide" : "Why?"}</button>
          </div>
        </div>
      </div>

      {p.isOpen && (
        <div className="mt-3 rounded-md bg-slate-50 px-4 py-3 text-xs text-slate-600">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-slate-800">{l.explanation.headline}</span>
            <Badge tone={STATUS_TONE[l.ruleStatus]}>{STATUS_LABEL[l.ruleStatus]}</Badge>
            <span className="text-slate-400">Rule {l.ruleId}</span>
          </div>
          <ul className="mt-2 list-disc pl-5">{l.explanation.steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
          {Object.keys(l.inputsUsed).length > 0 && <p className="mt-2">Inputs used: {Object.entries(l.inputsUsed).map(([k, v]) => `${k} = ${v}`).join(", ")}</p>}
          <p className="mt-2"><span className="font-medium text-slate-700">Historic source:</span> {l.historicReference.source}</p>
          {def && <p className="mt-1"><span className="font-medium text-slate-700">Open question for NewQuip:</span> {def.seanQuestion}</p>}
          <p className="mt-1 text-slate-500">Quantities are per reference unit, multiplied by {Number.isFinite(p.rooms) ? p.rooms : "?"} (the workbook calls this “Rooms”; its exact meaning is awaiting NewQuip confirmation).</p>
          {m && <p className="mt-2"><span className="font-medium text-slate-700">Product mapping:</span> {m.note}{chosen?.reason ? ` Match basis: ${chosen.reason}.` : m.candidates[0]?.reason ? ` Match basis: ${m.candidates[0].reason}.` : ""}</p>}
          {b && b.status !== "priced" && b.status !== "not_selected" && <p className="mt-1 text-warning">Pricing: {b.reason}</p>}
          {b?.status === "priced" && <p className="mt-1">Pricing: {fmtMoney(b.unitPrice)} per unit (Cin7 price tier); cost {b.averageCost == null ? "unknown" : fmtMoney(b.averageCost)}; project quantity {b.quantity}.</p>}
          <label className="mt-3 flex items-center gap-2">
            <span className="font-medium text-slate-700">Manual quantity per unit</span>
            <input value={p.override} onChange={(e) => p.setOverride(e.target.value)} inputMode="decimal" placeholder="enter qty" className="w-24 rounded border border-slate-300 px-2 py-1 text-right" />
            <span className="text-slate-400">(marked MANUAL — not verified)</span>
          </label>
        </div>
      )}
    </li>
  );
}
