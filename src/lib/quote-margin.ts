// src/lib/quote-margin.ts
//
// Pure margin arithmetic for the Quotation + Margin module (brief §6/§7/§8/§18/§19/§20).
//
// This is the ONLY place quote financials are computed. It has no I/O and no currency
// conversion — V1 is ZAR-only, so every input on a single quote must already share one
// currency (see docs/quotation-margin-module.md "Decisions"). The UI uses these functions
// for the live per-line panel and footer; the server re-runs them on save so a client can
// never persist its own totals (brief: "Never trust client-calculated financial totals").
//
// Design rules that guard against the subtle failure modes the brief calls out:
//   • Numbers are returned at FULL precision. Callers round for display/storage — never
//     round intermediates, or per-line rounding drift corrupts the footer.
//   • The overall margin is WEIGHTED: it is computed from summed revenue and summed cost,
//     NEVER by averaging the per-line margin %s (brief §7).
//   • Margin is on revenue EXCLUDING tax (brief §6).
//   • A line whose cost is unknown is EXCLUDED from the margin numerator/denominator (its
//     margin is "N/A") but still counts toward the quote subtotal/total. Uncosted additional
//     charges are the same shape — a charge is just a line with `averageCost == null`
//     (decision: uncosted charges excluded from margin). This prevents an unknown cost from
//     silently inflating the reported margin.
//   • Margin % is `null` (render as "N/A") whenever revenue is 0 — never a divide-by-zero.

/** A single quote line (a product line, or an additional charge — charges just omit cost). */
export interface QuoteLineInput {
  /** Quantity. May be fractional. */
  quantity: number;
  /** Per-unit selling price, expressed in the quote's tax mode (see QuoteCalcOptions). */
  unitPrice: number;
  /** Line discount, 0..100. Defaults to 0. */
  discountPct?: number;
  /**
   * Quote-time ex-tax unit cost (Cin7 Average Cost snapshot). `null`/`undefined` means the
   * cost is unknown for this line — it is then excluded from the margin, never treated as 0.
   */
  averageCost?: number | null;
  /** Line tax rate as a percent, e.g. 15 for 15%. Defaults to 0. */
  taxRatePct?: number;
  /**
   * When true, this line's cost is deliberately held OUT of the margin (e.g. a shipping/additional
   * charge the user chose to exclude) — cost/GP/margin show as N/A and it never inflates the margin,
   * even if an averageCost is present. Its revenue still counts toward the subtotal/total. Product
   * lines never set this; it's the charge Exclude/Include control.
   */
  excludedFromMargin?: boolean;
}

export interface QuoteCalcOptions {
  /** When true, `unitPrice` already includes tax and is stripped back to ex-tax for margin. */
  taxInclusive?: boolean;
}

export interface LineResult {
  /** Selling price per unit after discount, in the quote's tax mode. */
  netUnitPrice: number;
  /** Line revenue excluding tax — the margin basis. */
  revenueExTax: number;
  /** Tax portion of the line. */
  taxAmount: number;
  /** revenueExTax + taxAmount. */
  totalIncTax: number;
  /** averageCost × quantity, or `null` when the cost is unknown. */
  estimatedCost: number | null;
  /** revenueExTax − estimatedCost, or `null` when the cost is unknown. */
  estimatedGP: number | null;
  /** GP / revenueExTax × 100, or `null` when revenue ≤ 0 or cost unknown ("N/A"). */
  marginPct: number | null;
  /** Whether a usable cost was supplied. */
  hasCost: boolean;
}

export interface QuoteResult {
  /** Sum of ex-tax revenue across ALL lines (costed and uncosted) — the quote subtotal. */
  subtotalExTax: number;
  /** Sum of line tax. */
  taxTotal: number;
  /** subtotalExTax + taxTotal. */
  totalIncTax: number;
  /** Sum of known line costs. */
  estimatedCost: number;
  /** marginRevenueExTax − estimatedCost. */
  estimatedGP: number;
  /** Ex-tax revenue of ONLY the costed lines — the weighted-margin denominator. */
  marginRevenueExTax: number;
  /** Weighted overall margin %, or `null` when no costed revenue exists ("N/A"). */
  overallMarginPct: number | null;
  /** How many lines contributed a cost to the margin. */
  costedLineCount: number;
  /** How many revenue-bearing lines were left out of the margin for lack of a cost. */
  excludedFromMarginCount: number;
  /** Total number of lines considered. */
  lineCount: number;
}

/** Coerce to a finite number, else `fallback`. Guards against NaN/Infinity/strings from inputs. */
function num(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function hasUsableCost(cost: number | null | undefined): boolean {
  return cost != null && Number.isFinite(Number(cost));
}

/** Compute the financials for one line. Pure; returns full-precision numbers. */
export function computeLine(line: QuoteLineInput, opts: QuoteCalcOptions = {}): LineResult {
  const qty = num(line.quantity);
  const unitPrice = num(line.unitPrice);
  const discountPct = num(line.discountPct);
  const taxRate = num(line.taxRatePct);
  const taxInclusive = opts.taxInclusive === true;

  const netUnitPrice = unitPrice * (1 - discountPct / 100);
  // Margin is always on the ex-tax figure. In tax-inclusive mode strip the tax back out.
  const netUnitExTax = taxInclusive ? netUnitPrice / (1 + taxRate / 100) : netUnitPrice;
  const revenueExTax = netUnitExTax * qty;
  const taxAmount = taxInclusive
    ? (netUnitPrice - netUnitExTax) * qty
    : revenueExTax * (taxRate / 100);
  const totalIncTax = revenueExTax + taxAmount;

  // A cost counts toward the margin only if it's known AND not deliberately excluded. An excluded
  // line (or one with an unknown cost) reports cost/GP/margin as N/A and never inflates the margin.
  const costCounts = hasUsableCost(line.averageCost) && line.excludedFromMargin !== true;
  const estimatedCost = costCounts ? num(line.averageCost) * qty : null;
  const estimatedGP = estimatedCost == null ? null : revenueExTax - estimatedCost;
  // N/A rather than divide-by-zero when there is no revenue to earn a margin against.
  const marginPct =
    estimatedGP != null && revenueExTax > 0 ? (estimatedGP / revenueExTax) * 100 : null;

  return {
    netUnitPrice,
    revenueExTax,
    taxAmount,
    totalIncTax,
    estimatedCost,
    estimatedGP,
    marginPct,
    hasCost: costCounts,
  };
}

/**
 * Aggregate a whole quote. The overall margin is weighted (summed revenue / summed cost of
 * costed lines only), never an average of the per-line %s. Uncosted lines/charges add to the
 * subtotal and total but are held out of the margin pools and counted separately.
 */
export function computeQuote(lines: QuoteLineInput[], opts: QuoteCalcOptions = {}): QuoteResult {
  const rows = Array.isArray(lines) ? lines : [];
  let subtotalExTax = 0;
  let taxTotal = 0;
  let totalIncTax = 0;
  let marginRevenueExTax = 0;
  let estimatedCost = 0;
  let costedLineCount = 0;
  let excludedFromMarginCount = 0;

  for (const line of rows) {
    const r = computeLine(line, opts);
    subtotalExTax += r.revenueExTax;
    taxTotal += r.taxAmount;
    totalIncTax += r.totalIncTax;
    if (r.estimatedCost != null) {
      marginRevenueExTax += r.revenueExTax;
      estimatedCost += r.estimatedCost;
      costedLineCount += 1;
    } else if (r.revenueExTax > 0) {
      excludedFromMarginCount += 1;
    }
  }

  const estimatedGP = marginRevenueExTax - estimatedCost;
  const overallMarginPct =
    marginRevenueExTax > 0 ? (estimatedGP / marginRevenueExTax) * 100 : null;

  return {
    subtotalExTax,
    taxTotal,
    totalIncTax,
    estimatedCost,
    estimatedGP,
    marginRevenueExTax,
    overallMarginPct,
    costedLineCount,
    excludedFromMarginCount,
    lineCount: rows.length,
  };
}

/**
 * §18 "price to margin" helper: the ex-tax net unit price needed to hit `targetMarginPct`
 * given an ex-tax unit cost. Returns `null` for an invalid cost or an unreachable target
 * (≥100%, where the required price is infinite).
 */
export function requiredNetPriceForMargin(
  estimatedUnitCost: number,
  targetMarginPct: number,
): number | null {
  const cost = num(estimatedUnitCost, NaN);
  const t = num(targetMarginPct) / 100;
  if (!Number.isFinite(cost) || cost < 0) return null;
  if (t >= 1) return null;
  return cost / (1 - t);
}

/** Round a money value to 2 decimals for display/storage. Callers apply this at the edge only. */
export function round2(value: number): number {
  return Math.round((num(value) + Number.EPSILON) * 100) / 100;
}
