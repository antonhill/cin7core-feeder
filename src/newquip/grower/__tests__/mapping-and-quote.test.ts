import { describe, expect, it } from "vitest";
import { resolveMapping } from "../mapping";
import { buildBudgetQuote, type ProductCommercials } from "../quote-bridge";
import { calculateGrowerHouse } from "../calculate";
import { TOPIGS_GROWER_INPUT } from "../fixture";
import { computeQuote } from "@/lib/quote-margin";

const cat = new Set(["CCM-1", "MAT-1"]);

describe("product mapping status", () => {
  it("UNMAPPED with no candidates", () => expect(resolveMapping("feeder", [], null, cat).status).toBe("UNMAPPED"));
  it("AMBIGUOUS with several candidates and none confirmed", () => {
    const r = resolveMapping("feeder", [{ sku: "A", name: "a" }, { sku: "B", name: "b" }], null, cat);
    expect(r.status).toBe("AMBIGUOUS");
    expect(r.note).toContain("REQUIRES NEWQUIP SKU CONFIRMATION");
  });
  it("a single unconfirmed candidate is still AMBIGUOUS (never auto-mapped)", () => {
    expect(resolveMapping("feeder", [{ sku: "CCM-1", name: "x" }], null, cat).status).toBe("AMBIGUOUS");
  });
  it("MAPPED only when confirmed AND present in the catalogue", () => {
    expect(resolveMapping("feeder", [], "CCM-1", cat)).toMatchObject({ status: "MAPPED", sku: "CCM-1" });
    expect(resolveMapping("feeder", [], "NOPE", cat).status).toBe("UNMAPPED");
  });
});

describe("quote / margin integration", () => {
  const withQty = calculateGrowerHouse({ ...TOPIGS_GROWER_INPUT, quantityOverrides: { feeder: 18, feed_saver_mat: 18 } });
  const mappings = new Map([
    ["feeder", resolveMapping("feeder", [], "CCM-1", cat)],
    ["feed_saver_mat", resolveMapping("feed_saver_mat", [], "MAT-1", cat)],
  ]);
  const prod = (sku: string, cost: number | null, price: number): ProductCommercials => ({ sku, name: sku, active: true, averageCost: cost, tierPrices: { Tier1: price } });
  const opts = { tierCode: "Tier1", taxRatePct: 15, taxInclusive: false };

  it("uses the existing engine: totals equal computeQuote over the same inputs", () => {
    const b = buildBudgetQuote(withQty.lines, mappings, new Map([["CCM-1", prod("CCM-1", 100, 200)], ["MAT-1", prod("MAT-1", 10, 20)]]), opts);
    const expected = computeQuote(
      [
        { quantity: 216, unitPrice: 200, taxRatePct: 15, averageCost: 100 },
        { quantity: 216, unitPrice: 20, taxRatePct: 15, averageCost: 10 },
      ],
      { taxInclusive: false },
    );
    expect(b.totals).toEqual(expected);
    expect(b.totals.overallMarginPct).toBeCloseTo(50, 6);
  });

  it("unvalidated lines are reported, make the budget incomplete, and add nothing to totals", () => {
    const b = buildBudgetQuote(withQty.lines, mappings, new Map([["CCM-1", prod("CCM-1", 100, 200)], ["MAT-1", prod("MAT-1", 10, 20)]]), opts);
    expect(b.incomplete).toBe(true);
    expect(b.lines.find((l) => l.itemKey === "cup_drinker")!.status).toBe("no_quantity");
    expect(b.blockers.some((x) => x.includes("no validated quantity"))).toBe(true);
  });

  it("a missing price fails visibly and is NOT priced at zero", () => {
    const b = buildBudgetQuote(withQty.lines, mappings, new Map([["CCM-1", { ...prod("CCM-1", 100, 200), tierPrices: {} }], ["MAT-1", prod("MAT-1", 10, 20)]]), opts);
    const l = b.lines.find((x) => x.itemKey === "feeder")!;
    expect(l.status).toBe("no_price");
    expect(l.revenueExTax).toBeNull();
    expect(b.totals.lineCount).toBe(1);
  });

  it("a missing cost is flagged and excluded from margin, never costed as 0", () => {
    const b = buildBudgetQuote(withQty.lines, mappings, new Map([["CCM-1", prod("CCM-1", null, 200)], ["MAT-1", prod("MAT-1", 10, 20)]]), opts);
    const l = b.lines.find((x) => x.itemKey === "feeder")!;
    expect(l).toMatchObject({ status: "priced", costMissing: true, estimatedCost: null, marginPct: null });
    expect(b.blockers.some((x) => x.includes("no Average Cost"))).toBe(true);
    expect(b.totals.excludedFromMarginCount).toBe(1);
  });

  it("an unmapped product or inactive product is reported, not priced", () => {
    const b = buildBudgetQuote(withQty.lines, new Map(), new Map(), opts);
    expect(b.lines.find((x) => x.itemKey === "feeder")!.status).toBe("unmapped");
    const inactive = buildBudgetQuote(withQty.lines, mappings, new Map([["CCM-1", { ...prod("CCM-1", 1, 2), active: false }]]), opts);
    expect(inactive.lines.find((x) => x.itemKey === "feeder")!.status).toBe("product_missing");
  });

  it("no price tier chosen → no_price (not zero)", () => {
    const b = buildBudgetQuote(withQty.lines, mappings, new Map([["CCM-1", prod("CCM-1", 1, 2)]]), { ...opts, tierCode: null });
    expect(b.lines.find((x) => x.itemKey === "feeder")!.status).toBe("no_price");
  });
});
