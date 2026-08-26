// src/lib/quote-build.ts
//
// The bridge between a client-submitted quote draft and the persisted, server-authoritative
// rows. It is PURE (no I/O) so the actions layer stays a thin fetch-then-persist shell and the
// money logic is unit-testable without a database.
//
// The one financial-integrity rule this enforces (brief: "Never trust client-calculated
// financial totals"): the client supplies only the commercial INPUTS it legitimately controls —
// which product, quantity, selling price, discount, tax rate. The COST comes from the server's
// own synced Cin7 Average Cost (`products.average_cost`), passed in here as `costBySku`, never
// from the client. Every revenue/GP/margin figure and the footer totals are then recomputed here
// via src/lib/quote-margin.ts. A client cannot inflate a margin by sending a fake cost or a fake
// total — it never sends either.

import {
  computeLine,
  computeQuote,
  type QuoteLineInput,
  type QuoteCalcOptions,
  type QuoteResult,
} from "./quote-margin";

export type QuoteLineType = "product" | "charge";

/** A single line as submitted by the builder UI (inputs only — no cost, no computed figures). */
export interface QuoteLineDraft {
  lineType: QuoteLineType;
  cin7ProductId?: string | null;
  productSku?: string | null;
  productName?: string | null;
  quantity: number;
  unitPrice: number;
  discountPct?: number;
  taxRatePct?: number;
}

/** A line resolved with its server-sourced cost + computed snapshot, shaped for the quote_lines row. */
export interface ResolvedQuoteLineRow {
  line_number: number;
  line_type: QuoteLineType;
  cin7_product_id: string | null;
  product_sku: string | null;
  product_name: string | null;
  quantity: number;
  unit_price: number;
  discount_pct: number;
  tax_rate_pct: number;
  average_cost: number | null;
  revenue_ex_tax: number;
  estimated_cost: number | null;
  estimated_gp: number | null;
  margin_pct: number | null;
}

export interface ResolvedQuote {
  lines: ResolvedQuoteLineRow[];
  totals: QuoteResult;
}

function normaliseSku(sku: string | null | undefined): string {
  return (sku ?? "").trim();
}

/**
 * Resolve every draft line against the server-sourced cost map and compute the quote.
 *
 * @param drafts    the client-submitted lines (inputs only).
 * @param costBySku server-sourced ex-tax unit cost per product SKU (from products.average_cost).
 *                  A SKU absent from the map, or mapped to null, means "cost unknown" → that line
 *                  is excluded from the margin (never costed as 0). Charge lines never look up a
 *                  cost (a charge's cost is not a product cost) and are always uncosted here.
 * @param opts      tax mode (inclusive/exclusive) for the whole quote.
 *
 * The footer totals are computed from the SAME raw engine inputs as the lines (not by re-summing
 * the row snapshots), so per-line values and the footer can never disagree.
 */
export function resolveQuoteLines(
  drafts: QuoteLineDraft[],
  costBySku: Map<string, number | null>,
  opts: QuoteCalcOptions = {},
): ResolvedQuote {
  const engineInputs: QuoteLineInput[] = [];
  const lines: ResolvedQuoteLineRow[] = (drafts ?? []).map((d, i) => {
    const averageCost =
      d.lineType === "charge" ? null : costBySku.get(normaliseSku(d.productSku)) ?? null;

    const input: QuoteLineInput = {
      quantity: d.quantity,
      unitPrice: d.unitPrice,
      discountPct: d.discountPct,
      taxRatePct: d.taxRatePct,
      averageCost,
    };
    engineInputs.push(input);

    const r = computeLine(input, opts);
    return {
      line_number: i + 1,
      line_type: d.lineType === "charge" ? "charge" : "product",
      cin7_product_id: d.cin7ProductId ?? null,
      product_sku: d.productSku ?? null,
      product_name: d.productName ?? null,
      quantity: Number(d.quantity) || 0,
      unit_price: Number(d.unitPrice) || 0,
      discount_pct: Number(d.discountPct) || 0,
      tax_rate_pct: Number(d.taxRatePct) || 0,
      average_cost: averageCost,
      revenue_ex_tax: r.revenueExTax,
      estimated_cost: r.estimatedCost,
      estimated_gp: r.estimatedGP,
      margin_pct: r.marginPct,
    };
  });

  return { lines, totals: computeQuote(engineInputs, opts) };
}

/** The distinct, non-empty product SKUs in a draft — the set the actions layer looks up costs for. */
export function productSkusFor(drafts: QuoteLineDraft[]): string[] {
  const seen = new Set<string>();
  for (const d of drafts ?? []) {
    if (d.lineType === "charge") continue;
    const sku = normaliseSku(d.productSku);
    if (sku) seen.add(sku);
  }
  return [...seen];
}
