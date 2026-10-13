import { computeLine, computeQuote, type QuoteLineInput, type QuoteResult } from "@/lib/quote-margin";
import type { GeneratedLine } from "./types";
import type { MappingResolution } from "./mapping";

// Feeds generated, mapped lines into the EXISTING quote engine (src/lib/quote-margin.ts). No tax, margin,
// GP or total arithmetic is re-implemented here. A line is only costed when it has a quantity, a MAPPED
// product, and a price; anything else is reported — never defaulted to 0.

export interface ProductCommercials {
  sku: string;
  name: string;
  active: boolean;
  /** Ex-tax unit cost (Cin7 Average Cost) or null when unknown. */
  averageCost: number | null;
  /** Selling price keyed "Tier1".."Tier10". */
  tierPrices: Record<string, number>;
}

export type BridgeLineStatus = "priced" | "no_quantity" | "not_selected" | "unmapped" | "product_missing" | "no_price";

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
  revenueExTax: number | null;
  estimatedCost: number | null;
  estimatedGP: number | null;
  marginPct: number | null;
}

/** How much of the budget can be trusted as money. Drives the headline — never show a zero total as a quote. */
export type BudgetState = "awaiting_pricing" | "partial" | "complete";

export interface BudgetQuote {
  lines: BridgeLine[];
  totals: QuoteResult;
  state: BudgetState;
  pricedLineCount: number;
  /** True while any line that should be on the quote is missing a quantity/mapping/price/cost. */
  incomplete: boolean;
  blockers: string[];
}

export interface BudgetOptions {
  /** e.g. "Tier3" — the price tier all lines are priced from. */
  tierCode: string | null;
  taxRatePct: number;
  taxInclusive: boolean;
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

  const base = (g: GeneratedLine) => ({
    itemKey: g.itemKey,
    label: g.label,
    sku: null as string | null,
    quantity: g.projectQuantity,
    unitPrice: null as number | null,
    averageCost: null as number | null,
    costMissing: false,
    revenueExTax: null as number | null,
    estimatedCost: null as number | null,
    estimatedGP: null as number | null,
    marginPct: null as number | null,
  });

  for (const g of generated) {
    if (g.basis === "not_selected") {
      bridge.push({ ...base(g), status: "not_selected", reason: "Optional — not selected." });
      continue;
    }
    if (g.projectQuantity == null) {
      bridge.push({ ...base(g), status: "no_quantity", reason: "Rule awaiting NewQuip validation — no quantity." });
      blockers.push(`${g.label}: no validated quantity`);
      continue;
    }
    const m = mappings.get(g.itemKey);
    if (!m || m.status !== "MAPPED" || !m.sku) {
      bridge.push({ ...base(g), status: "unmapped", reason: m ? `Product mapping ${m.status}.` : "Product mapping UNMAPPED." });
      blockers.push(`${g.label}: product ${m?.status ?? "UNMAPPED"}`);
      continue;
    }
    const p = products.get(m.sku);
    if (!p || !p.active) {
      bridge.push({ ...base(g), sku: m.sku, status: "product_missing", reason: `${m.sku} not found or inactive in Cin7.` });
      blockers.push(`${g.label}: ${m.sku} not found/inactive`);
      continue;
    }
    const price = opts.tierCode ? p.tierPrices[opts.tierCode] : undefined;
    if (price == null || !Number.isFinite(price) || price <= 0) {
      bridge.push({ ...base(g), sku: m.sku, averageCost: p.averageCost, status: "no_price", reason: `No ${opts.tierCode ?? "price tier"} price for ${m.sku}.` });
      blockers.push(`${g.label}: no selling price`);
      continue;
    }
    const input: QuoteLineInput = {
      quantity: g.projectQuantity,
      unitPrice: price,
      taxRatePct: opts.taxRatePct,
      averageCost: p.averageCost,
    };
    engineLines.push(input);
    const r = computeLine(input, { taxInclusive: opts.taxInclusive });
    const costMissing = p.averageCost == null;
    if (costMissing) blockers.push(`${g.label}: no Average Cost — margin incomplete`);
    bridge.push({
      ...base(g),
      sku: m.sku,
      status: "priced",
      reason: costMissing ? "Priced; cost unknown so excluded from margin." : "Priced.",
      unitPrice: price,
      averageCost: p.averageCost,
      costMissing,
      revenueExTax: r.revenueExTax,
      estimatedCost: r.estimatedCost,
      estimatedGP: r.estimatedGP,
      marginPct: r.marginPct,
    });
  }

  const incomplete = blockers.length > 0;
  const state: BudgetState = engineLines.length === 0 ? "awaiting_pricing" : incomplete ? "partial" : "complete";
  return {
    lines: bridge,
    totals: computeQuote(engineLines, { taxInclusive: opts.taxInclusive }),
    state,
    pricedLineCount: engineLines.length,
    incomplete,
    blockers,
  };
}
