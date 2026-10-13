import { computeLine, computeQuote, type QuoteLineInput, type QuoteResult } from "@/lib/quote-margin";
import type { GeneratedLine, GrowerItemKey } from "./types";
import type { MappingResolution } from "./mapping";
import { manualLinesFor, packageFor, type PackageComponent } from "./commercial";

// Feeds generated, mapped lines into the EXISTING quote engine (src/lib/quote-margin.ts). No tax, margin,
// GP or total arithmetic is re-implemented here. A line is only costed when it has a quantity, a confirmed
// product (or confirmed package), and a price; anything else is reported — never defaulted to 0.
// A PACKAGE contributes to totals only when EVERY component is priced; a partly-priced package is incomplete
// and adds nothing (a drinker without its pipe is not a price).

export interface ProductCommercials {
  sku: string;
  name: string;
  active: boolean;
  /** Ex-tax unit cost (Cin7 Average Cost) or null when unknown. */
  averageCost: number | null;
  /** Selling price keyed "Tier1".."Tier10". */
  tierPrices: Record<string, number>;
  /** Total available stock across locations, when looked up. */
  available?: number | null;
}

/** The NewQuip trial catalogue is seeded with Average Cost 50 and availability 1000 — suspect, not evidence. */
export const SEEDED_COST = 50;
export const SEEDED_AVAILABILITY = 1000;
export type DataTrust = "suspect" | "unknown" | "missing";
export function costTrust(cost: number | null | undefined): DataTrust {
  if (cost == null || !Number.isFinite(cost)) return "missing";
  return cost === SEEDED_COST ? "suspect" : "unknown";
}
export function availabilityTrust(avail: number | null | undefined): DataTrust {
  if (avail == null || !Number.isFinite(avail)) return "missing";
  return avail === SEEDED_AVAILABILITY ? "suspect" : "unknown";
}

export type BridgeLineStatus =
  | "priced"
  | "no_quantity"
  | "not_selected"
  | "unmapped"
  | "product_missing"
  | "no_price"
  | "package_unconfirmed"
  | "package_incomplete";

export type BridgeComponentStatus = "priced" | "no_quantity" | "identity_unresolved" | "not_in_catalogue" | "no_price";

export interface BridgeComponent {
  id: string;
  sku: string | null;
  description: string;
  qtyPerUnit: number | null;
  /** Total component quantity for the order (qtyPerUnit × package units), or null if not knowable. */
  quantity: number | null;
  historicTopigsQty: number | null;
  status: BridgeComponentStatus;
  reason: string;
  unitPrice: number | null;
  averageCost: number | null;
  costTrust: DataTrust;
  available: number | null;
  availabilityTrust: DataTrust;
  revenueExTax: number | null;
  estimatedCost: number | null;
}

export interface BridgeLine {
  itemKey: GeneratedLine["itemKey"];
  label: string;
  status: BridgeLineStatus;
  reason: string;
  sku: string | null;
  quantity: number | null;
  unitPrice: number | null;
  averageCost: number | null;
  costMissing: boolean;
  costTrust: DataTrust;
  revenueExTax: number | null;
  estimatedCost: number | null;
  estimatedGP: number | null;
  marginPct: number | null;
  /** Present for package outputs. */
  components?: BridgeComponent[];
}

/** How much of the budget can be trusted as money. Drives the headline — never show a zero total as a quote. */
export type BudgetState = "awaiting_pricing" | "partial" | "complete";

export interface BudgetQuote {
  lines: BridgeLine[];
  totals: QuoteResult;
  state: BudgetState;
  /** Outputs (a package counts once) that are fully priced. */
  pricedLineCount: number;
  /** True while any line that should be on the quote is missing a quantity/mapping/price/cost. */
  incomplete: boolean;
  blockers: string[];
  /** Data-quality warnings that do not block pricing (e.g. seeded placeholder costs). */
  warnings: string[];
}

export interface BudgetOptions {
  /** e.g. "Tier3" — the price tier all lines are priced from. */
  tierCode: string | null;
  taxRatePct: number;
  taxInclusive: boolean;
  /** Output items whose package definition a person has explicitly confirmed this session. */
  confirmedPackages?: ReadonlySet<GrowerItemKey>;
}

const emptyLine = (g: GeneratedLine) => ({
  itemKey: g.itemKey,
  label: g.label,
  sku: null as string | null,
  quantity: g.projectQuantity,
  unitPrice: null as number | null,
  averageCost: null as number | null,
  costMissing: false,
  costTrust: "missing" as DataTrust,
  revenueExTax: null as number | null,
  estimatedCost: null as number | null,
  estimatedGP: null as number | null,
  marginPct: null as number | null,
});

function priceOf(p: ProductCommercials | undefined, tierCode: string | null): number | undefined {
  const price = tierCode && p ? p.tierPrices[tierCode] : undefined;
  return price != null && Number.isFinite(price) && price > 0 ? price : undefined;
}

function evaluateComponent(
  c: PackageComponent,
  packageUnits: number,
  products: Map<string, ProductCommercials>,
  opts: BudgetOptions,
): { comp: BridgeComponent; input: QuoteLineInput | null } {
  const p = c.sku ? products.get(c.sku) : undefined;
  const base = {
    id: c.id,
    sku: c.sku,
    description: c.description,
    qtyPerUnit: c.qtyPerUnit,
    historicTopigsQty: c.historicTopigsQty ?? null,
    unitPrice: null as number | null,
    averageCost: p?.averageCost ?? null,
    costTrust: costTrust(p?.averageCost),
    available: p?.available ?? null,
    availabilityTrust: availabilityTrust(p?.available),
    revenueExTax: null as number | null,
    estimatedCost: null as number | null,
  };
  // Identity first: an uncertain/unidentified component can't be priced, whatever its quantity.
  if (!c.sku) return { comp: { ...base, quantity: null, status: "identity_unresolved", reason: c.identity === "uncertain" ? "SKU identity not settled — awaiting NewQuip" : "No SKU identified in the source" }, input: null };
  // Quantity: only a source-fixed composition is usable; the Topigs historic figure is never priced.
  if (c.quantityStatus !== "source_fixed" || c.qtyPerUnit == null) return { comp: { ...base, quantity: null, status: "no_quantity", reason: "Quantity depends on layout — awaiting NewQuip validation" }, input: null };
  const quantity = c.qtyPerUnit * packageUnits;
  if (!p || !p.active) return { comp: { ...base, quantity, status: "not_in_catalogue", reason: `${c.sku} not found or inactive in Cin7` }, input: null };
  const price = priceOf(p, opts.tierCode);
  if (price == null) return { comp: { ...base, quantity, status: "no_price", reason: `No ${opts.tierCode ?? "price tier"} price for ${c.sku}` }, input: null };
  const input: QuoteLineInput = { quantity, unitPrice: price, taxRatePct: opts.taxRatePct, averageCost: p.averageCost };
  const r = computeLine(input, { taxInclusive: opts.taxInclusive });
  return { comp: { ...base, quantity, status: "priced", reason: "Priced", unitPrice: price, revenueExTax: r.revenueExTax, estimatedCost: r.estimatedCost }, input };
}

export function buildBudgetQuote(
  generated: GeneratedLine[],
  mappings: Map<string, MappingResolution>,
  products: Map<string, ProductCommercials>,
  opts: BudgetOptions,
): BudgetQuote {
  const bridge: BridgeLine[] = [];
  const engineLines: QuoteLineInput[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];
  let pricedOutputs = 0;

  for (const g of generated) {
    if (g.basis === "not_selected") {
      bridge.push({ ...emptyLine(g), status: "not_selected", reason: "Optional — not selected." });
      continue;
    }
    if (g.projectQuantity == null) {
      bridge.push({ ...emptyLine(g), status: "no_quantity", reason: "Rule awaiting NewQuip validation — no quantity." });
      blockers.push(`${g.label}: no validated quantity`);
      continue;
    }

    // A separate manual charge (e.g. slat delivery) is never folded into the SKU; flag it until it has a price.
    for (const m of manualLinesFor(g.itemKey)) blockers.push(`${m.description}: manual charge not priced (separate from the SKU)`);

    // ---- PACKAGE ----
    const pkg = packageFor(g.itemKey);
    if (pkg) {
      if (!opts.confirmedPackages?.has(g.itemKey)) {
        bridge.push({ ...emptyLine(g), status: "package_unconfirmed", reason: "Package sourced from the NewQuip workbook — awaiting NewQuip confirmation.", components: pkg.components.map((c) => evaluateComponent(c, g.projectQuantity!, products, { ...opts, tierCode: null }).comp) });
        blockers.push(`${g.label}: package awaiting confirmation`);
        continue;
      }
      const evals = pkg.components.map((c) => evaluateComponent(c, g.projectQuantity!, products, opts));
      const comps = evals.map((e) => e.comp);
      const missing = comps.filter((c) => c.status !== "priced");
      if (missing.length > 0) {
        bridge.push({ ...emptyLine(g), status: "package_incomplete", reason: `${missing.length} of ${comps.length} components not priced.`, components: comps });
        blockers.push(`${g.label}: ${missing.length} of ${comps.length} package components not priced`);
        continue;
      }
      // Fully priced: every component goes through the existing engine; the package line is their sum.
      for (const e of evals) engineLines.push(e.input!);
      pricedOutputs += 1;
      const revenue = comps.reduce((a, c) => a + (c.revenueExTax ?? 0), 0);
      const anyCostMissing = comps.some((c) => c.estimatedCost == null);
      const cost = anyCostMissing ? null : comps.reduce((a, c) => a + (c.estimatedCost ?? 0), 0);
      if (anyCostMissing) blockers.push(`${g.label}: a component has no Average Cost — margin incomplete`);
      if (comps.some((c) => c.costTrust === "suspect")) warnings.push(`${g.label}: package uses placeholder Average Cost (50) on some components`);
      bridge.push({ ...emptyLine(g), status: "priced", reason: "Package priced from its components.", revenueExTax: revenue, estimatedCost: cost, estimatedGP: cost == null ? null : revenue - cost, marginPct: cost == null || revenue <= 0 ? null : ((revenue - cost) / revenue) * 100, costMissing: anyCostMissing, components: comps });
      continue;
    }

    // ---- SINGLE SKU (or unresolved) ----
    const m = mappings.get(g.itemKey);
    if (!m || m.status !== "MAPPED" || !m.sku) {
      bridge.push({ ...emptyLine(g), status: "unmapped", reason: m ? `Product mapping ${m.status}.` : "Product mapping UNMAPPED." });
      blockers.push(`${g.label}: product ${m?.status ?? "UNMAPPED"}`);
      continue;
    }
    const p = products.get(m.sku);
    if (!p || !p.active) {
      bridge.push({ ...emptyLine(g), sku: m.sku, status: "product_missing", reason: `${m.sku} not found or inactive in Cin7.` });
      blockers.push(`${g.label}: ${m.sku} not found/inactive`);
      continue;
    }
    const price = priceOf(p, opts.tierCode);
    if (price == null) {
      bridge.push({ ...emptyLine(g), sku: m.sku, averageCost: p.averageCost, costTrust: costTrust(p.averageCost), status: "no_price", reason: `No ${opts.tierCode ?? "price tier"} price for ${m.sku}.` });
      blockers.push(`${g.label}: no selling price`);
      continue;
    }
    const input: QuoteLineInput = { quantity: g.projectQuantity, unitPrice: price, taxRatePct: opts.taxRatePct, averageCost: p.averageCost };
    engineLines.push(input);
    pricedOutputs += 1;
    const r = computeLine(input, { taxInclusive: opts.taxInclusive });
    const costMissing = p.averageCost == null;
    const trust = costTrust(p.averageCost);
    if (costMissing) blockers.push(`${g.label}: no Average Cost — margin incomplete`);
    if (trust === "suspect") warnings.push(`${g.label}: ${m.sku} Average Cost is the placeholder 50 — margin not reliable`);
    bridge.push({
      ...emptyLine(g),
      sku: m.sku,
      status: "priced",
      reason: costMissing ? "Priced; cost unknown so excluded from margin." : "Priced.",
      unitPrice: price,
      averageCost: p.averageCost,
      costMissing,
      costTrust: trust,
      revenueExTax: r.revenueExTax,
      estimatedCost: r.estimatedCost,
      estimatedGP: r.estimatedGP,
      marginPct: r.marginPct,
    });
  }

  const incomplete = blockers.length > 0;
  const state: BudgetState = pricedOutputs === 0 ? "awaiting_pricing" : incomplete ? "partial" : "complete";
  return {
    lines: bridge,
    totals: computeQuote(engineLines, { taxInclusive: opts.taxInclusive }),
    state,
    pricedLineCount: pricedOutputs,
    incomplete,
    blockers,
    warnings,
  };
}
