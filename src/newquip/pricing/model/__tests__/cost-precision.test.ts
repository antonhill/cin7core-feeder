import { describe, expect, it } from "vitest";
import { calculatePricing, cost7, formatCost7, fromCost7, landedCents, landedCentsE7, LEGACY_RULE_VERSION, micro, type PricingScenario } from "..";

// NQ-008B follow-up: Cin7 reports supplier-native costs with up to 7 decimals (6.5454755, 26.8440995). They are held exactly (units of 1e-7), converted with exact BigInt arithmetic and rounded to cents
// ONCE, half-up, by the model's existing rule. A cost with more than 7 decimals is refused: never truncated, never rounded. Every expected figure below was computed independently with exact decimals.

const AT = "2026-11-14T08:00:00.000Z";
const one = (currency: string, cost: string, rate: string, freight: string): { landed: number | null; price: number | null; issues: string[] } => {
  const s: PricingScenario = {
    pricingDate: AT,
    fxQuotes: currency === "ZAR" ? {} : { [currency]: { rateMicro: micro(rate), source: "test rate", asOf: AT } },
    forwardCover: {},
    lines: [{ key: "L", label: "L", sku: "L", quantity: 1, cost: { supplierId: null, supplierName: "S", currency, nativeUnitCostE7: cost7(cost), verification: "verified", source: "Cin7 supplier price" }, freight: { factorMicro: micro(freight), source: "test" } }],
    itemOverrides: {}, projectMarkup: null, projectAdjustment: null,
  };
  const r = calculatePricing(s, LEGACY_RULE_VERSION);
  return { landed: r.lines[0].unitLandedCostCents, price: r.lines[0].unitPriceCents, issues: r.lines[0].issues.map((i) => i.code) };
};

describe("cost7: 7-decimal supplier-native costs are parsed exactly and never rounded", () => {
  it("accepts up to 7 decimals as an exact integer", () => {
    expect(cost7("6.5454755")).toBe(65_454_755);
    expect(cost7("26.8440995")).toBe(268_440_995);
    expect(cost7(6.5454755)).toBe(65_454_755); // a number typed or pasted into the form
    expect(cost7("100")).toBe(1_000_000_000);
    expect(cost7("0.0000001")).toBe(1);
    expect(cost7("0")).toBe(0);
  });
  it("refuses more than 7 decimals (no silent truncation or rounding), negatives, exponents and junk", () => {
    for (const bad of ["6.54547551", "0.00000001", "-1", "1e-7", "", "abc", "1,5", "1.", ".5", " "]) expect(() => cost7(bad)).toThrow(/at most 7 decimals/);
    expect(() => cost7(Number.NaN)).toThrow();
    expect(() => cost7(Number.POSITIVE_INFINITY)).toThrow();
  });
  it("refuses a value too large to hold exactly (no silent precision loss)", () => {
    expect(() => cost7("99999999999.9999999")).toThrow(/too large/);
    expect(cost7("900719925.4740991")).toBe(Number.MAX_SAFE_INTEGER);
  });
  it("formatCost7 gives an exact plain decimal that cost7 parses back (never exponent text)", () => {
    for (const t of ["6.5454755", "26.8440995", "100", "0.0000001", "0.5", "1234567.1"]) expect(formatCost7(cost7(t))).toBe(t);
    expect(formatCost7(0)).toBe("0");
    expect(formatCost7(1)).toBe("0.0000001");
  });
  it("round-trips for display", () => {
    expect(fromCost7(cost7("6.5454755"))).toBe(6.5454755);
    expect(String(fromCost7(cost7("26.8440995")))).toBe("26.8440995");
  });
});

describe("landedCentsE7 is exact and agrees with the micro-unit conversion wherever both can express the cost", () => {
  it("gives the same cents as landedCents for costs of at most 6 decimals", () => {
    for (const [c, r, f] of [["100", "20", "1.15"], ["0.005", "1", "1"], ["0.004", "1", "1"], ["393.48", "18.4195", "1.25"], ["1174.51", "16.5555", "1.3"], ["3.14", "1", "1"]] as const) {
      expect(landedCentsE7(cost7(c), micro(r), micro(f))).toBe(landedCents(micro(c), micro(r), micro(f)));
    }
  });
  it("rounds half-up exactly at the cent boundary", () => {
    expect(landedCentsE7(cost7("0.125"), micro("1"), micro("1"))).toBe(13); // 12.5 cents: half up
    expect(landedCentsE7(cost7("0.1249995"), micro("1"), micro("1"))).toBe(12); // 12.49995 cents: the 7th decimal matters and is NOT dropped
    expect(landedCentsE7(cost7("0.1250005"), micro("1"), micro("1"))).toBe(13);
  });
});

describe("regression: the Cin7 costs that have 7 decimals", () => {
  it("QCA00003 (USD 6.5454755 at 16.5555, freight 1.5): landed R162.55, price R195.06 at the 20% rule markup", () => {
    expect(one("USD", "6.5454755", "16.5555", "1.5")).toEqual({ landed: 16_255, price: 19_506, issues: [] });
  });
  it("ERT053 (EUR 26.8440995 at 18.4195, freight 1.1): landed R543.90, price R652.68", () => {
    expect(one("EUR", "26.8440995", "18.4195", "1.1")).toEqual({ landed: 54_390, price: 65_268, issues: [] });
  });
  it("the 7th decimal is carried, not truncated: 0.1249995 prices at 12 cents, where a cost rounded to 6 decimals (0.125) would give 13", () => {
    expect(one("ZAR", "0.1249995", "1", "1")).toMatchObject({ landed: 12, price: 14 });
    expect(one("ZAR", "0.125", "1", "1")).toMatchObject({ landed: 13, price: 16 });
  });
  it("the same inputs always give the same result (deterministic, no floating point in the path)", () => {
    const a = one("EUR", "26.8440995", "18.4195", "1.1");
    for (let i = 0; i < 20; i++) expect(one("EUR", "26.8440995", "18.4195", "1.1")).toEqual(a);
  });
  it("a cost that is not an integer count of 1e-7 units is rejected by the model's own validation", () => {
    const s: PricingScenario = {
      pricingDate: AT, fxQuotes: {}, forwardCover: {},
      lines: [{ key: "L", label: "L", sku: "L", quantity: 1, cost: { supplierId: null, supplierName: "S", currency: "ZAR", nativeUnitCostE7: 1.5, verification: "verified", source: "x" }, freight: { factorMicro: micro("1"), source: "t" } }],
      itemOverrides: {}, projectMarkup: null, projectAdjustment: null,
    };
    expect(() => calculatePricing(s, LEGACY_RULE_VERSION)).toThrow(/supplier cost must be a non-negative number/);
  });
});
