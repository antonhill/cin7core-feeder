import { describe, it, expect } from "vitest";
import {
  computeLine,
  computeQuote,
  requiredNetPriceForMargin,
  round2,
  type QuoteLineInput,
} from "../quote-margin";

// Brief §40 test matrix: standard/discounted/negative/zero-revenue/missing-cost/decimal-qty
// lines, the WEIGHTED overall margin, tax-inclusive vs -exclusive equivalence, and the
// price-to-margin helper. Money is compared with toBeCloseTo where floating point applies.

describe("computeLine", () => {
  it("standard positive-margin line: revenue ex-tax, GP and margin %", () => {
    const r = computeLine({ quantity: 10, unitPrice: 100, averageCost: 60 });
    expect(r.revenueExTax).toBe(1000);
    expect(r.estimatedCost).toBe(600);
    expect(r.estimatedGP).toBe(400);
    expect(r.marginPct).toBeCloseTo(40, 10);
    expect(r.hasCost).toBe(true);
  });

  it("applies a line discount before computing revenue and margin", () => {
    const r = computeLine({ quantity: 5, unitPrice: 200, discountPct: 10, averageCost: 120 });
    expect(r.netUnitPrice).toBe(180);
    expect(r.revenueExTax).toBe(900); // 180 × 5
    expect(r.estimatedCost).toBe(600); // 120 × 5
    expect(r.estimatedGP).toBe(300);
    expect(r.marginPct).toBeCloseTo(33.3333, 3);
  });

  it("negative margin when cost exceeds revenue", () => {
    const r = computeLine({ quantity: 1, unitPrice: 50, averageCost: 80 });
    expect(r.estimatedGP).toBe(-30);
    expect(r.marginPct).toBeCloseTo(-60, 10);
  });

  it("zero selling price → revenue 0 → margin N/A (null, not a divide-by-zero)", () => {
    const r = computeLine({ quantity: 4, unitPrice: 0, averageCost: 20 });
    expect(r.revenueExTax).toBe(0);
    expect(r.estimatedCost).toBe(80);
    expect(r.estimatedGP).toBe(-80);
    expect(r.marginPct).toBeNull();
  });

  it("100% discount → revenue 0 → margin N/A", () => {
    const r = computeLine({ quantity: 3, unitPrice: 100, discountPct: 100, averageCost: 40 });
    expect(r.netUnitPrice).toBe(0);
    expect(r.revenueExTax).toBe(0);
    expect(r.marginPct).toBeNull();
  });

  it("missing cost (null) → cost/GP/margin all null, but revenue still computed", () => {
    const r = computeLine({ quantity: 2, unitPrice: 150, averageCost: null });
    expect(r.revenueExTax).toBe(300);
    expect(r.estimatedCost).toBeNull();
    expect(r.estimatedGP).toBeNull();
    expect(r.marginPct).toBeNull();
    expect(r.hasCost).toBe(false);
  });

  it("undefined cost is treated the same as missing", () => {
    const r = computeLine({ quantity: 1, unitPrice: 10 });
    expect(r.hasCost).toBe(false);
    expect(r.estimatedCost).toBeNull();
  });

  it("a zero cost is a real, usable cost (100% margin), not 'missing'", () => {
    const r = computeLine({ quantity: 2, unitPrice: 50, averageCost: 0 });
    expect(r.hasCost).toBe(true);
    expect(r.estimatedCost).toBe(0);
    expect(r.marginPct).toBeCloseTo(100, 10);
  });

  it("decimal quantity is supported", () => {
    const r = computeLine({ quantity: 2.5, unitPrice: 40, averageCost: 10 });
    expect(r.revenueExTax).toBe(100);
    expect(r.estimatedCost).toBe(25);
    expect(r.marginPct).toBeCloseTo(75, 10);
  });

  it("zero quantity → revenue 0 → margin N/A", () => {
    const r = computeLine({ quantity: 0, unitPrice: 100, averageCost: 40 });
    expect(r.revenueExTax).toBe(0);
    expect(r.estimatedCost).toBe(0);
    expect(r.marginPct).toBeNull();
  });

  it("tax-exclusive: tax is added on top; revenue and margin are unaffected by tax", () => {
    const r = computeLine({ quantity: 1, unitPrice: 100, averageCost: 60, taxRatePct: 15 });
    expect(r.revenueExTax).toBe(100);
    expect(r.taxAmount).toBeCloseTo(15, 10);
    expect(r.totalIncTax).toBeCloseTo(115, 10);
    expect(r.marginPct).toBeCloseTo(40, 10);
  });

  it("tax-inclusive: the same economics yield the same ex-tax revenue and margin", () => {
    const exclusive = computeLine(
      { quantity: 2, unitPrice: 100, averageCost: 60, taxRatePct: 15 },
      { taxInclusive: false },
    );
    const inclusive = computeLine(
      { quantity: 2, unitPrice: 115, averageCost: 60, taxRatePct: 15 },
      { taxInclusive: true },
    );
    expect(inclusive.revenueExTax).toBeCloseTo(exclusive.revenueExTax, 8);
    expect(inclusive.taxAmount).toBeCloseTo(exclusive.taxAmount, 8);
    expect(inclusive.totalIncTax).toBeCloseTo(exclusive.totalIncTax, 8);
    expect(inclusive.marginPct).toBeCloseTo(exclusive.marginPct as number, 8);
  });

  it("coerces non-finite / bad inputs to 0 rather than producing NaN", () => {
    const r = computeLine({
      quantity: Number.NaN as unknown as number,
      unitPrice: Infinity as unknown as number,
      averageCost: 5,
    });
    expect(Number.isFinite(r.revenueExTax)).toBe(true);
    expect(r.revenueExTax).toBe(0);
  });
});

describe("computeQuote", () => {
  it("weighted overall margin uses summed revenue/cost, NOT an average of line %s", () => {
    // Line A: big, low margin (10%). Line B: tiny, high margin (80%).
    // Naive average of %s = 45%. Correct weighted margin is dominated by line A.
    const lines: QuoteLineInput[] = [
      { quantity: 1, unitPrice: 1000, averageCost: 900 }, // rev 1000, gp 100, 10%
      { quantity: 1, unitPrice: 10, averageCost: 2 }, //     rev 10,   gp 8,   80%
    ];
    const q = computeQuote(lines);
    expect(q.subtotalExTax).toBe(1010);
    expect(q.estimatedCost).toBe(902);
    expect(q.estimatedGP).toBe(108);
    expect(q.overallMarginPct).toBeCloseTo((108 / 1010) * 100, 10); // ≈ 10.69%, not 45%
    expect(q.overallMarginPct).toBeLessThan(11);
  });

  it("uncosted lines add to the subtotal/total but are excluded from the margin", () => {
    const lines: QuoteLineInput[] = [
      { quantity: 1, unitPrice: 100, averageCost: 60 }, // costed
      { quantity: 1, unitPrice: 500, averageCost: null }, // uncosted charge
    ];
    const q = computeQuote(lines);
    expect(q.subtotalExTax).toBe(600); // both count toward the quote value
    expect(q.marginRevenueExTax).toBe(100); // only the costed line drives margin
    expect(q.estimatedCost).toBe(60);
    expect(q.estimatedGP).toBe(40);
    expect(q.overallMarginPct).toBeCloseTo(40, 10);
    expect(q.costedLineCount).toBe(1);
    expect(q.excludedFromMarginCount).toBe(1);
    expect(q.lineCount).toBe(2);
  });

  it("all lines uncosted → overall margin is N/A (null), subtotal still correct", () => {
    const q = computeQuote([
      { quantity: 1, unitPrice: 300 },
      { quantity: 2, unitPrice: 100 },
    ]);
    expect(q.subtotalExTax).toBe(500);
    expect(q.marginRevenueExTax).toBe(0);
    expect(q.overallMarginPct).toBeNull();
    expect(q.excludedFromMarginCount).toBe(2);
    expect(q.costedLineCount).toBe(0);
  });

  it("a zero-revenue uncosted line is not counted as 'excluded from margin'", () => {
    // No cost AND no revenue → nothing to include or exclude; must not inflate the excluded tally.
    const q = computeQuote([{ quantity: 0, unitPrice: 0 }]);
    expect(q.excludedFromMarginCount).toBe(0);
    expect(q.costedLineCount).toBe(0);
    expect(q.overallMarginPct).toBeNull();
  });

  it("aggregates tax across lines and derives the inc-tax total", () => {
    const q = computeQuote([
      { quantity: 1, unitPrice: 100, averageCost: 50, taxRatePct: 15 },
      { quantity: 1, unitPrice: 200, averageCost: 100, taxRatePct: 15 },
    ]);
    expect(q.subtotalExTax).toBe(300);
    expect(q.taxTotal).toBeCloseTo(45, 10);
    expect(q.totalIncTax).toBeCloseTo(345, 10);
    expect(q.overallMarginPct).toBeCloseTo(50, 10);
  });

  it("empty / non-array input returns a zeroed, N/A quote without throwing", () => {
    const q = computeQuote(undefined as unknown as QuoteLineInput[]);
    expect(q).toMatchObject({
      subtotalExTax: 0,
      taxTotal: 0,
      totalIncTax: 0,
      estimatedCost: 0,
      estimatedGP: 0,
      marginRevenueExTax: 0,
      overallMarginPct: null,
      costedLineCount: 0,
      excludedFromMarginCount: 0,
      lineCount: 0,
    });
  });

  it("does not average-away a loss: a costed giveaway line drags overall GP negative", () => {
    const q = computeQuote([
      { quantity: 1, unitPrice: 100, averageCost: 40 }, // +60 gp
      { quantity: 1, unitPrice: 0, averageCost: 90 }, //   -90 gp (given away at a loss)
    ]);
    expect(q.estimatedGP).toBe(-30);
    expect(q.marginRevenueExTax).toBe(100);
    expect(q.overallMarginPct).toBeCloseTo(-30, 10);
  });
});

describe("requiredNetPriceForMargin", () => {
  it("returns the ex-tax price that achieves the target margin", () => {
    // At 40% margin on a cost of 60: price = 60 / 0.6 = 100.
    expect(requiredNetPriceForMargin(60, 40)).toBeCloseTo(100, 10);
  });

  it("a 0% target just returns the cost", () => {
    expect(requiredNetPriceForMargin(75, 0)).toBe(75);
  });

  it("an unreachable target (≥100%) returns null", () => {
    expect(requiredNetPriceForMargin(50, 100)).toBeNull();
    expect(requiredNetPriceForMargin(50, 150)).toBeNull();
  });

  it("an invalid / negative cost returns null", () => {
    expect(requiredNetPriceForMargin(Number.NaN, 40)).toBeNull();
    expect(requiredNetPriceForMargin(-10, 40)).toBeNull();
  });

  it("round-trips with computeLine: pricing at the required price yields the target margin", () => {
    const price = requiredNetPriceForMargin(60, 35) as number;
    const r = computeLine({ quantity: 1, unitPrice: price, averageCost: 60 });
    expect(r.marginPct).toBeCloseTo(35, 8);
  });
});

describe("round2", () => {
  it("rounds to two decimals at the edge", () => {
    expect(round2(1.005)).toBe(1.01);
    expect(round2(2.344)).toBe(2.34);
    expect(round2(100)).toBe(100);
  });
});
