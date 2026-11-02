import { describe, expect, it } from "vitest";
import { convertToZarCents, normaliseOption, rateToMicro, rawFromCin7, selectSupplier, selectionNeedsReason, DEFAULT_MAX_RATE_AGE_HOURS, type FxRate, type NormaliseEnv, type RawSupplierPrice } from "../supplier-price";

const BIG_1E6 = BigInt(1000000);
const NOW = "2026-10-30T08:00:00Z";
const usd: FxRate = { currency: "USD", rate: "17.5", source: "Entered by estimator from the SARB 30 Oct fixing", asOf: "2026-10-30T06:00:00Z" };
const basis = { basis: "STOCK_UNIT" as const, confirmedBy: "est@x", confirmedAt: NOW, reason: "NewQuip confirmed prices are per stock unit" };
const env = (over: Partial<NormaliseEnv> = {}): NormaliseEnv => ({ fx: { USD: usd }, nowIso: NOW, maxRateAgeHours: DEFAULT_MAX_RATE_AGE_HOURS, unitBasis: basis, ...over });
const raw = (over: Partial<RawSupplierPrice> = {}): RawSupplierPrice => ({ supplierId: "s1", supplierName: "Supplier A", cost: 850, currency: "ZAR", lastSupplied: "2026-10-01T00:00:00", ...over });

describe("1-4: single and multiple suppliers in ZAR and USD", () => {
  it("1. a single ZAR supplier converts at rate 1 and keeps the original price", () => {
    const o = normaliseOption(raw(), env());
    expect(o).toMatchObject({ status: "USABLE", zarUnitCents: 85_000, currency: "ZAR", priceMicro: 850_000_000, fx: null });
  });
  it("2. a single USD supplier is converted with the recorded rate and keeps the original price, currency and rate", () => {
    const o = normaliseOption(raw({ supplierId: "s2", supplierName: "Supplier B", cost: 45, currency: "USD" }), env());
    expect(o).toMatchObject({ status: "USABLE", zarUnitCents: 78_750, currency: "USD", priceMicro: 45_000_000, fx: { rate: "17.5", source: usd.source, asOf: usd.asOf } });
  });
  it("3. two ZAR suppliers are both kept and each is evaluated independently", () => {
    const a = normaliseOption(raw({ cost: 850 }), env()); const b = normaliseOption(raw({ supplierId: "s2", supplierName: "B", cost: 790 }), env());
    expect([a.zarUnitCents, b.zarUnitCents]).toEqual([85_000, 79_000]);
    expect(selectSupplier([a, b]).status).toBe("NEEDS_CHOICE");
  });
  it("4. ZAR and USD together: the owner's example (R850.00 vs US$45.00 at 17.50 = R787.50) - nothing is auto-chosen, not even the cheaper", () => {
    const a = normaliseOption(raw({ cost: 850 }), env()); const b = normaliseOption(raw({ supplierId: "s2", supplierName: "Supplier B", cost: 45, currency: "USD" }), env());
    expect(b.zarUnitCents).toBe(78_750);
    const sel = selectSupplier([a, b]);
    expect(sel).toMatchObject({ status: "NEEDS_CHOICE", chosen: null, option: null }); // the cheaper USD supplier is NOT picked for the estimator
  });
});

describe("5-7: preference", () => {
  const A = () => normaliseOption(raw({ preferred: true }), env());
  const B = () => normaliseOption(raw({ supplierId: "s2", supplierName: "B", cost: 700 }), env());
  it("5. a usable preferred supplier is selected even when another is cheaper", () => {
    const sel = selectSupplier([A(), B()]);
    expect(sel).toMatchObject({ status: "SELECTED", chosen: { supplierId: "s1", method: "PREFERRED" }, option: { zarUnitCents: 85_000 } });
  });
  it("6. with no preference a single usable supplier is automatic; several require a choice; none is MISSING", () => {
    expect(selectSupplier([normaliseOption(raw(), env())])).toMatchObject({ status: "SELECTED", chosen: { method: "AUTO_SINGLE" } });
    expect(selectSupplier([normaliseOption(raw(), env()), B()]).status).toBe("NEEDS_CHOICE");
    expect(selectSupplier([]).status).toBe("MISSING");
    expect(selectSupplier([normaliseOption(raw({ cost: null }), env())]).status).toBe("MISSING");
  });
  it("7. a preferred supplier with no usable cost is shown as a problem and does NOT silently fall back to the other supplier", () => {
    const pref = normaliseOption(raw({ preferred: true, cost: null }), env());
    const sel = selectSupplier([pref, B()]);
    expect(sel.status).toBe("PREFERRED_INVALID");
    expect(sel.chosen).toBeNull();
    expect(sel.message).toMatch(/no usable price/);
  });
  it("two suppliers both flagged preferred is not a valid preference", () => {
    const sel = selectSupplier([normaliseOption(raw({ preferred: true }), env()), normaliseOption(raw({ supplierId: "s2", supplierName: "B", preferred: true }), env())]);
    expect(sel.status).toBe("NEEDS_CHOICE");
    expect(sel.message).toMatch(/More than one supplier is marked preferred/);
  });
  it("a deliberate estimator choice stands; a choice that has become unusable is not kept", () => {
    const a = normaliseOption(raw(), env()); const b = B();
    const keep = selectSupplier([a, b], { supplierId: "s2", supplierName: "B", method: "MANUAL_SELECTION", reason: "Better lead time", by: "e", at: NOW });
    expect(keep).toMatchObject({ status: "SELECTED", chosen: { method: "MANUAL_SELECTION" }, option: { supplierId: "s2" } });
    const gone = selectSupplier([a, normaliseOption(raw({ supplierId: "s2", supplierName: "B", cost: null }), env())], { supplierId: "s2", supplierName: "B", method: "MANUAL_SELECTION" });
    expect(gone.status).toBe("SELECTED"); // only A is usable and nothing is preferred
    expect(gone.chosen!.method).toBe("AUTO_SINGLE");
  });
  it("changing an existing choice, or choosing against the preference, needs a recorded reason", () => {
    const a = A(); const b = B();
    expect(selectionNeedsReason(null, { supplierId: "s2", supplierName: "B" }, [a, b])).toBe(true); // against the preference
    expect(selectionNeedsReason(null, { supplierId: "s1", supplierName: "Supplier A" }, [a, b])).toBe(false);
    expect(selectionNeedsReason({ supplierId: "s1", supplierName: "A", method: "MANUAL_SELECTION" }, { supplierId: "s2", supplierName: "B" }, [normaliseOption(raw(), env()), b])).toBe(true);
  });
});

describe("8-11: currency, rates and dates", () => {
  it("8. an invalid or missing supplier currency is unusable and is never read as rand", () => {
    for (const currency of ["US", "dollar", "ZA1", "", null]) {
      const o = normaliseOption(raw({ currency }), env());
      expect(o.status).toBe("UNUSABLE");
      expect(o.zarUnitCents).toBeNull();
      expect(o.problems.some((p) => p.code === (currency === null || currency === "" ? "NO_CURRENCY" : "INVALID_CURRENCY"))).toBe(true);
    }
  });
  it("9. a missing exchange rate makes a foreign price unusable (not rand)", () => {
    const o = normaliseOption(raw({ currency: "USD", cost: 45 }), env({ fx: {} }));
    expect(o).toMatchObject({ status: "UNUSABLE", zarUnitCents: null });
    expect(o.problems[0]).toMatchObject({ code: "NO_RATE", blocking: true });
    expect(normaliseOption(raw({ currency: "EUR", cost: 45 }), env()).problems[0].code).toBe("NO_RATE"); // only USD is recorded
  });
  it("10. a stale or invalid rate is refused", () => {
    expect(normaliseOption(raw({ currency: "USD", cost: 45 }), env({ fx: { USD: { ...usd, asOf: "2026-10-20T06:00:00Z" } } })).problems[0].code).toBe("STALE_RATE");
    expect(normaliseOption(raw({ currency: "USD", cost: 45 }), env({ fx: { USD: { ...usd, rate: "abc" } } })).problems[0].code).toBe("INVALID_RATE");
    expect(normaliseOption(raw({ currency: "USD", cost: 45 }), env({ fx: { USD: { ...usd, rate: "0" } } })).problems[0].code).toBe("INVALID_RATE");
    expect(normaliseOption(raw({ currency: "USD", cost: 45 }), env({ fx: { USD: { ...usd, rate: "-17" } } })).problems[0].code).toBe("INVALID_RATE");
    expect(normaliseOption(raw({ currency: "USD", cost: 45 }), env({ fx: { USD: { ...usd, asOf: "not a date" } } })).problems[0].code).toBe("INVALID_RATE");
  });
  it("11. a malformed LastSupplied date is flagged as informational and does not change the cost or the selection", () => {
    const a = normaliseOption(raw({ lastSupplied: "garbage" }), env());
    expect(a).toMatchObject({ status: "USABLE", zarUnitCents: 85_000, lastSuppliedValid: false });
    expect(a.problems).toEqual([{ code: "BAD_DATE", message: expect.stringContaining("garbage"), blocking: false }]);
    // the date never selects the supplier: the older-dated supplier is not dropped, the newer one is not preferred
    const sel = selectSupplier([normaliseOption(raw({ lastSupplied: "2020-01-01" }), env()), normaliseOption(raw({ supplierId: "s2", supplierName: "B", lastSupplied: "2026-10-29" }), env())]);
    expect(sel.status).toBe("NEEDS_CHOICE");
  });
  it("conversion is exact and rounds half up once: R0.005 x 1 and boundary cases", () => {
    expect(convertToZarCents(45_000_000, rateToMicro("17.5")!, BIG_1E6)).toBe(78_750);
    expect(convertToZarCents(10_000, rateToMicro("1")!, BIG_1E6)).toBe(1); // 1 cent exactly
    expect(convertToZarCents(4_999, rateToMicro("1")!, BIG_1E6)).toBe(0); // 0.4999 cent -> 0
    expect(convertToZarCents(5_000, rateToMicro("1")!, BIG_1E6)).toBe(1); // 0.5 cent -> 1 (half up)
    expect(convertToZarCents(12_345_678, rateToMicro("18.123456")!, BIG_1E6)).toBe(22_375); // 12.345678 x 18.123456 = 223.7462 -> 22374.62 cents -> half up
    expect(rateToMicro("17.1234567")).toBeNull();
    expect(rateToMicro("17,5")).toBeNull();
  });
});

describe("12-14: units of measure, and a missing cost is never zero", () => {
  it("12. a supplier unit different from the stock unit uses the stated conversion factor (a box of 10 is NOT a unit)", () => {
    const o = normaliseOption(raw({ cost: 100, purchaseUnit: "Box", stockUnit: "Item", conversionFactor: 10 }), env());
    expect(o).toMatchObject({ status: "USABLE", zarUnitCents: 1_000, purchaseUnit: "Box", conversionFactor: 10 });
  });
  it("13. a different purchase unit with no conversion factor is unusable", () => {
    const o = normaliseOption(raw({ cost: 100, purchaseUnit: "Box", stockUnit: "Item" }), env());
    expect(o).toMatchObject({ status: "UNUSABLE", zarUnitCents: null });
    expect(o.problems[0].code).toBe("BAD_CONVERSION_FACTOR");
    expect(normaliseOption(raw({ conversionFactor: 0, purchaseUnit: "Box" }), env()).problems[0].code).toBe("BAD_CONVERSION_FACTOR");
    expect(normaliseOption(raw({ conversionFactor: -2 }), env()).problems[0].code).toBe("BAD_CONVERSION_FACTOR");
  });
  it("13b. with no unit information at all the price is unusable until an authorised user confirms it is per stock unit", () => {
    const o = normaliseOption(raw(), env({ unitBasis: null }));
    expect(o).toMatchObject({ status: "UNUSABLE" });
    expect(o.problems[0].code).toBe("UOM_UNCONFIRMED");
    expect(normaliseOption(raw(), env()).status).toBe("USABLE");
  });
  it("14. a missing, zero, negative, NaN or rounds-to-zero price never becomes a cost of zero", () => {
    for (const cost of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.0000004]) {
      const o = normaliseOption(raw({ cost }), env());
      expect(o.status).toBe("UNUSABLE");
      expect(o.zarUnitCents).toBeNull();
    }
    expect(selectSupplier([normaliseOption(raw({ cost: 0 }), env())]).status).toBe("MISSING");
  });
});

describe("the Cin7 record reader", () => {
  const cur = (n: string | null) => (n === "Acme" ? "ZAR" : n === "Dollar Co" ? "USD" : null);
  it("takes Cost as the Latest Price and ignores FixedCost; currency from the record, else from the supplier master", () => {
    expect(rawFromCin7({ SupplierName: "Acme", Cost: 12.5, FixedCost: 99, LastSupplied: "2026-10-01" }, cur)).toMatchObject({ supplierName: "Acme", cost: 12.5, currency: "ZAR" });
    expect(rawFromCin7({ SupplierName: "Dollar Co", Cost: 3, Currency: "EUR" }, cur).currency).toBe("EUR");
    expect(rawFromCin7({ SupplierName: "Nobody", Cost: 3 }, cur).currency).toBeNull(); // unknown currency stays unknown
    expect(rawFromCin7({ SupplierName: "Acme", FixedCost: 99 }, cur).cost).toBeNull(); // FixedCost is never a fallback
  });
});
