import { describe, expect, it } from "vitest";
import { marginFigures } from "@/lib/projects/margin-figures";
import { baseScenario } from "../fixtures";
import { calculatePricing, figures, lineCents, LEGACY_RULE_VERSION, pct2, quantityMilli, withMarkupBps, landedCents, micro } from "..";

// THE EXACT ROUNDING RULE (documented in money.ts and docs/newquip-nq008b-pricing-foundation.md):
//   money = whole cents, half up in exact integers; a margin / markup percentage = half up to 2 decimals, in exact integers; ties go AWAY from zero.
describe("percentages: half up to 2 decimals, exactly", () => {
  it("the 14.125% boundary rounds UP to 14.13 (and 14.124 stays 14.12)", () => {
    expect(pct2(1_130_000, 8_000_000)).toBe(14.13); // 14.125% exactly
    expect(pct2(1_412_400, 10_000_000)).toBe(14.12); // 14.124%
    expect(pct2(1_412_500, 10_000_000)).toBe(14.13); // 14.125%
    expect(pct2(1_412_600, 10_000_000)).toBe(14.13);
  });
  it("other exact ties: 0.005 -> 0.01, 33.335 -> 33.34, 100% and 0%", () => {
    expect(pct2(5, 100_000)).toBe(0.01);
    expect(pct2(33_335, 100_000)).toBe(33.34);
    expect(pct2(100, 100)).toBe(100);
    expect(pct2(0, 100)).toBe(0);
  });
  it("a loss rounds away from zero as well: -14.125% is -14.13%", () => {
    expect(pct2(-1_130_000, 8_000_000)).toBe(-14.13);
    expect(pct2(-1_412_400, 10_000_000)).toBe(-14.12);
  });
  it("margin is on the selling price and markup on the cost, computed separately", () => {
    expect(figures(8_000_000, 6_870_000)).toMatchObject({ gpCents: 1_130_000, marginPct: 14.13, markupPct: 16.45 });
    expect(figures(8_244_000, 6_870_000)).toMatchObject({ marginPct: 16.67, markupPct: 20 });
  });
  it("unknown or degenerate inputs give null, never a number", () => {
    expect(figures(1_000, null)).toMatchObject({ gpCents: null, marginPct: null, markupPct: null });
    expect(figures(0, 500)).toMatchObject({ marginPct: null }); // no selling price
    expect(figures(500, 0)).toMatchObject({ gpCents: 500, markupPct: null, marginPct: 100 }); // no cost: markup undefined
  });
  it("the model's end-to-end margin at the 14.125% boundary", () => {
    const r = calculatePricing(baseScenario({ projectAdjustment: { kind: "target_total", targetTotalCents: 8_000_000, reason: "r", by: "x", at: "2026-11-12T08:00:00.000Z" } }), { ...LEGACY_RULE_VERSION });
    expect(r.margin).toMatchObject({ gpCents: 1_130_000, marginPct: 14.13, markupPct: 16.45 });
  });
});

describe("the shared Projects helper is UNCHANGED, and its tie behaviour is pinned so the difference is visible", () => {
  it("marginFigures still shows the 14.125% boundary as 14.12 (floating-point rounding) - the model's 14.13 is a deliberate, documented difference of 0.01 at exact ties only", () => {
    expect(marginFigures(8_000_000, 6_870_000).marginPct).toBe(14.12);
    expect(marginFigures(8_000_000, 6_870_000).markupPct).toBe(16.45);
  });
  it("away from a tie the two agree", () => {
    for (const [s, c] of [[8_244_000, 6_870_000], [8_360_000, 6_870_000], [8_010_000, 6_870_000], [123_457, 99_999]]) {
      expect(figures(s, c).marginPct).toBe(marginFigures(s, c).marginPct);
      expect(figures(s, c).markupPct).toBe(marginFigures(s, c).markupPct);
    }
  });
});

describe("money: half up in exact integers", () => {
  it("markup on landed: 101 750 x 1.25 = 127 187.5 -> 127 188; 1 cent x 1.5 = 1.5 -> 2", () => {
    expect(withMarkupBps(101_750, 2500)).toBe(127_188);
    expect(withMarkupBps(1, 5000)).toBe(2);
    expect(withMarkupBps(0, 2000)).toBe(0);
  });
  it("landed: native x rate x freight to the cent, ties up", () => {
    expect(landedCents(micro("100"), micro("20"), micro("1.15"))).toBe(230_000);
    expect(landedCents(micro("0.005"), micro("1"), micro("1"))).toBe(1); // 0.5 cent -> 1
    expect(landedCents(micro("0.004"), micro("1"), micro("1"))).toBe(0);
  });
  it("line amounts: fractional quantities are exact (3 decimals), not floating point", () => {
    expect(lineCents(125, 2.5)).toBe(313); // 312.5 -> 313
    expect(lineCents(1, 0.5)).toBe(1);
    expect(lineCents(10, 0.1 + 0.2)).toBe(3); // 0.30000000000000004 is still 0.3
    expect(quantityMilli(0.1 + 0.2)).toBe(300);
    expect(quantityMilli(1.0001)).toBeNull();
    expect(() => lineCents(100, 1.0001)).toThrow();
  });
});
