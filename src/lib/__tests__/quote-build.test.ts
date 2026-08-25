import { describe, it, expect } from "vitest";
import { resolveQuoteLines, productSkusFor, type QuoteLineDraft } from "../quote-build";

function product(sku: string, over: Partial<QuoteLineDraft> = {}): QuoteLineDraft {
  return { lineType: "product", productSku: sku, quantity: 1, unitPrice: 100, ...over };
}
function charge(over: Partial<QuoteLineDraft> = {}): QuoteLineDraft {
  return { lineType: "charge", productName: "Freight", quantity: 1, unitPrice: 100, ...over };
}

describe("resolveQuoteLines", () => {
  it("sources cost from the map, NOT from the client, and computes the snapshot", () => {
    const costs = new Map<string, number | null>([["SKU-1", 60]]);
    const { lines, totals } = resolveQuoteLines([product("SKU-1", { quantity: 10, unitPrice: 100 })], costs);
    expect(lines[0].average_cost).toBe(60);
    expect(lines[0].revenue_ex_tax).toBe(1000);
    expect(lines[0].estimated_cost).toBe(600);
    expect(lines[0].margin_pct).toBeCloseTo(40, 10);
    expect(totals.overallMarginPct).toBeCloseTo(40, 10);
    expect(lines[0].line_number).toBe(1);
  });

  it("a SKU absent from the cost map is uncosted (excluded from margin), not costed as 0", () => {
    const { lines, totals } = resolveQuoteLines([product("MISSING", { quantity: 2, unitPrice: 150 })], new Map());
    expect(lines[0].average_cost).toBeNull();
    expect(lines[0].estimated_cost).toBeNull();
    expect(lines[0].margin_pct).toBeNull();
    expect(lines[0].revenue_ex_tax).toBe(300); // still in the subtotal
    expect(totals.subtotalExTax).toBe(300);
    expect(totals.marginRevenueExTax).toBe(0);
    expect(totals.overallMarginPct).toBeNull();
    expect(totals.excludedFromMarginCount).toBe(1);
  });

  it("a SKU explicitly mapped to null is treated as unknown cost", () => {
    const costs = new Map<string, number | null>([["SKU-1", null]]);
    const { lines } = resolveQuoteLines([product("SKU-1")], costs);
    expect(lines[0].average_cost).toBeNull();
    expect(lines[0].margin_pct).toBeNull();
  });

  it("charge lines never look up a cost, even if a same-name SKU exists in the map", () => {
    const costs = new Map<string, number | null>([["", 999], ["Freight", 5]]);
    const { lines, totals } = resolveQuoteLines([charge({ unitPrice: 250 })], costs);
    expect(lines[0].line_type).toBe("charge");
    expect(lines[0].average_cost).toBeNull();
    expect(totals.subtotalExTax).toBe(250);
    expect(totals.marginRevenueExTax).toBe(0);
    expect(totals.excludedFromMarginCount).toBe(1);
  });

  it("footer totals are weighted and match summed costed revenue, not an average of line %s", () => {
    const costs = new Map<string, number | null>([["BIG", 900], ["SMALL", 2]]);
    const drafts = [
      product("BIG", { quantity: 1, unitPrice: 1000 }), // 10%
      product("SMALL", { quantity: 1, unitPrice: 10 }), // 80%
    ];
    const { totals } = resolveQuoteLines(drafts, costs);
    expect(totals.overallMarginPct).toBeCloseTo((108 / 1010) * 100, 10);
    expect(totals.overallMarginPct).toBeLessThan(11);
  });

  it("trims SKUs when looking up cost", () => {
    const costs = new Map<string, number | null>([["SKU-1", 60]]);
    const { lines } = resolveQuoteLines([product("  SKU-1  ", { quantity: 1, unitPrice: 100 })], costs);
    expect(lines[0].average_cost).toBe(60);
  });

  it("passes tax mode through to the engine (inclusive strips tax before margin)", () => {
    const costs = new Map<string, number | null>([["SKU-1", 60]]);
    const { lines } = resolveQuoteLines(
      [product("SKU-1", { quantity: 1, unitPrice: 115, taxRatePct: 15 })],
      costs,
      { taxInclusive: true },
    );
    expect(lines[0].revenue_ex_tax).toBeCloseTo(100, 8);
    expect(lines[0].margin_pct).toBeCloseTo(40, 8);
  });

  it("renumbers lines from 1 in order and coerces bad numerics to 0", () => {
    const drafts = [
      product("A", { quantity: Number.NaN as unknown as number, unitPrice: 10 }),
      charge(),
      product("B"),
    ];
    const { lines } = resolveQuoteLines(drafts, new Map());
    expect(lines.map((l) => l.line_number)).toEqual([1, 2, 3]);
    expect(lines[0].quantity).toBe(0);
  });

  it("empty / nullish drafts return no lines and an N/A quote", () => {
    const { lines, totals } = resolveQuoteLines(undefined as unknown as QuoteLineDraft[], new Map());
    expect(lines).toEqual([]);
    expect(totals.lineCount).toBe(0);
    expect(totals.overallMarginPct).toBeNull();
  });
});

describe("productSkusFor", () => {
  it("returns distinct non-empty product SKUs, excluding charges", () => {
    const drafts = [product("A"), product("A"), product("  "), charge({ productName: "X" }), product("B")];
    expect(productSkusFor(drafts).sort()).toEqual(["A", "B"]);
  });

  it("handles nullish input", () => {
    expect(productSkusFor(undefined as unknown as QuoteLineDraft[])).toEqual([]);
  });
});
