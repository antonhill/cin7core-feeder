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

describe("Cin7 single-stock-UOM contract (NQ-Q-0023 UOM_UNCONFIRMED remediation)", () => {
  // Real Suppliers[] shape, confirmed live 2026-07-23 (see product-supplier-options.test.ts): SupplierID, SupplierName, Cost, Currency, ProductSupplierOptions.
  const live = { SupplierID: "57f035fa", SupplierName: "ARUMI", Cost: 494.46, Currency: "ZAR", LastSupplied: "2026-11-03T00:00:00", ProductSupplierOptions: [{ Lead: 10, ReorderQuantity: 500, MinimumToReorder: 500, Safety: 20 }], FixedCost: 0, DropShip: false };
  const fresh = (s: Record<string, unknown> = live, stockUnit: string | null = "Item") => ({ ...rawFromCin7(s, () => null), stockUnit });
  const noBasis = env({ unitBasis: null });

  it("a fresh record that states no unit, on a product with a stock unit, is per stock unit - no user confirmation needed, and the basis is recorded", () => {
    expect(rawFromCin7(live, () => null).statedUnitFields).toEqual([]); // ProductSupplierOptions (reorder qty, lead time), FixedCost, DropShip are not unit statements
    const o = normaliseOption(fresh(), noBasis);
    expect(o).toMatchObject({ status: "USABLE", zarUnitCents: 49_446, conversionFactor: 1, unitBasisSource: "CIN7_SINGLE_STOCK_UOM", problems: [] });
  });
  it("the price is NOT changed by the contract: same cents as a user-confirmed per-stock-unit price", () => {
    const a = normaliseOption(fresh(), noBasis); const b = normaliseOption({ ...fresh(), statedUnitFields: undefined }, env());
    expect(a.zarUnitCents).toBe(b.zarUnitCents);
    expect(b.unitBasisSource).toBe("CONFIRMED_BY_USER");
  });
  it("a fresh record whose product has NO stock unit stays UOM_UNCONFIRMED", () => {
    for (const su of [null, "", "  "]) {
      const o = normaliseOption(fresh(live, su), noBasis);
      expect(o).toMatchObject({ status: "UNUSABLE", zarUnitCents: null, unitBasisSource: null });
      expect(o.problems[0].code).toBe("UOM_UNCONFIRMED");
    }
  });
  it("a record captured before unit fields were tracked (statedUnitFields absent) is NOT assumed - it stays UOM_UNCONFIRMED until recaptured or confirmed", () => {
    const o = normaliseOption({ ...fresh(), statedUnitFields: undefined }, noBasis);
    expect(o.problems[0].code).toBe("UOM_UNCONFIRMED");
  });
  it("genuine exceptions stay blocked: any unit / pack / conversion field Cin7 returns on the record, even if a user has confirmed 'per stock unit'", () => {
    for (const extra of [{ PurchaseUnit: "Box" }, { UOM: "Carton" }, { PackSize: 12 }, { ConversionFactor: 6 }, { OrderMultiple: 24 }, { QuantityInPack: 10 }]) {
      const r = fresh({ ...live, ...extra });
      expect(r.statedUnitFields?.length).toBe(1);
      for (const e of [noBasis, env()]) {
        const o = normaliseOption(r, e);
        expect(o).toMatchObject({ status: "UNUSABLE", zarUnitCents: null });
        expect(o.problems[0].code).toBe("UOM_UNCONFIRMED");
        expect(o.problems[0].message).toContain(Object.keys(extra)[0]);
      }
    }
  });
  it("empty / null unit-named fields are not statements", () => {
    expect(rawFromCin7({ ...live, PurchaseUnit: null, UOM: "", PackSize: undefined }, () => null).statedUnitFields).toEqual([]);
  });
  it("a stated different purchase unit with no factor, or a bad factor, is still BAD_CONVERSION_FACTOR (not relaxed)", () => {
    expect(normaliseOption({ ...fresh(), purchaseUnit: "Box" }, noBasis).problems[0].code).toBe("BAD_CONVERSION_FACTOR");
    expect(normaliseOption({ ...fresh(), conversionFactor: 0 }, noBasis).problems[0].code).toBe("BAD_CONVERSION_FACTOR");
  });
  it("a stated factor still divides the cost (genuine pack-size conversion preserved)", () => {
    const o = normaliseOption({ ...fresh(), purchaseUnit: "Box", conversionFactor: 10 }, noBasis);
    expect(o).toMatchObject({ status: "USABLE", zarUnitCents: 4_945, unitBasisSource: "STATED_FACTOR" }); // 494.46 / 10 = 49.446 -> 49.45
  });
  it("reviewer cases: an unrecognised top-level or NESTED field (BagSize, ProductSupplierOptions[].CartonQty) blocks - the check is an allowlist", () => {
    expect(rawFromCin7({ ...live, BagSize: 25 }, () => null).statedUnitFields).toEqual(["BagSize"]);
    expect(rawFromCin7({ ...live, ProductSupplierOptions: [{ Lead: 1, CartonQty: 12 }] }, () => null).statedUnitFields).toEqual(["ProductSupplierOptions.CartonQty"]);
    expect(rawFromCin7({ ...live, ProductSupplierOptions: "x" }, () => null).statedUnitFields).toEqual(["ProductSupplierOptions"]);
    expect(normaliseOption(fresh({ ...live, BagSize: 25 }), env()).status).toBe("UNUSABLE");
  });
  it("reviewer case: purchaseUnit equal to stockUnit does not bypass a stated unit field", () => {
    const o = normaliseOption({ ...fresh({ ...live, PackSize: 12 }), purchaseUnit: "Item" }, noBasis);
    expect(o).toMatchObject({ status: "UNUSABLE" }); expect(o.problems[0].code).toBe("UOM_UNCONFIRMED");
  });
  it("a USD price through the single-stock-UOM path converts exactly as before, and survives a JSON round-trip of the stored raw", () => {
    const r = fresh({ ...live, Cost: 45, Currency: "USD" });
    const o = normaliseOption(r, env({ unitBasis: null }));
    expect(o).toMatchObject({ status: "USABLE", zarUnitCents: 78_750, unitBasisSource: "CIN7_SINGLE_STOCK_UOM" });
    const stored = JSON.parse(JSON.stringify(o)).raw as RawSupplierPrice;
    expect(normaliseOption(stored, env({ unitBasis: null })).zarUnitCents).toBe(78_750); // [] persists
    const legacy = JSON.parse(JSON.stringify({ ...r, statedUnitFields: undefined })) as RawSupplierPrice;
    expect(normaliseOption(legacy, env({ unitBasis: null })).problems[0].code).toBe("UOM_UNCONFIRMED");
  });
  // The REAL live shape (NQ-Q-0023 capture 2026-11-03): the four extra fields every record carried. IDs are sanitised placeholders; PurchaseCost's real value was not
  // saved by that capture, so both the equal-to-Cost and zero cases are covered.
  const liveReal = (cost: number, extra: Record<string, unknown> = {}) => ({ SupplierID: "00000000-0000-4000-8000-000000000001", SupplierName: "ARUMI", Cost: cost, FixedCost: 0, Currency: "ZAR", LastSupplied: "2026-11-03T00:00:00",
    ProductID: "00000000-0000-4000-8000-000000000002", ProductSupplierID: "00000000-0000-4000-8000-000000000003", IncludeInPricing: true, PurchaseCost: cost, ProductSupplierOptions: [], ...extra });
  it("the real live response shape (ProductID, ProductSupplierID, IncludeInPricing, PurchaseCost) is accepted: NQ1227 R269.00, SYSH-2750-3 R19,444.62, KNQ160 R118.78", () => {
    for (const [c, cents] of [[269, 26_900], [19444.62, 1_944_462], [118.78, 11_878]] as const) {
      const r = rawFromCin7(liveReal(c), () => null);
      expect(r.statedUnitFields).toEqual([]);
      const o = normaliseOption({ ...r, stockUnit: "Item" }, noBasis);
      expect(o).toMatchObject({ status: "USABLE", zarUnitCents: cents, unitBasisSource: "CIN7_SINGLE_STOCK_UOM" });
    }
    expect(rawFromCin7(liveReal(269, { PurchaseCost: 0 }), () => null).statedUnitFields).toEqual([]);
  });
  it("the four fields are accepted only in their expected shape: anything else, and a PurchaseCost that differs from Cost, still blocks", () => {
    const blocked = (extra: Record<string, unknown>) => normaliseOption({ ...rawFromCin7(liveReal(269, extra), () => null), stockUnit: "Item" }, env()).status === "UNUSABLE";
    expect(blocked({ PurchaseCost: 26.9 })).toBe(true); // 10x different: could be a per-pack/per-unit figure
    expect(blocked({ PurchaseCost: "269" })).toBe(true);
    expect(blocked({ IncludeInPricing: "yes" })).toBe(true);
    expect(blocked({ ProductID: 12 })).toBe(true);
    expect(blocked({ ProductSupplierID: "not-an-id" })).toBe(true);
    expect(rawFromCin7(liveReal(269, { PurchaseCost: 26.9 }), () => null).statedUnitFields).toEqual(["PurchaseCost (differs from Cost, or not a number)"]);
    expect(blocked({ PackSize: 12 })).toBe(true); // genuine unit/pack/carton/quantity/conversion fields still block alongside the metadata
    expect(blocked({ CartonQty: 6 })).toBe(true);
    expect(blocked({ ConversionFactor: 6 })).toBe(true);
  });
  it("the 24 NQ-Q-0023 SKUs: each is a single ZAR supplier with stock unit Item and no unit field -> usable at the exact Cin7 price, auto-selected", () => {
    const prices: Record<string, number> = { "DPL-PVC20X600": 132.36, ERT053: 494.46, HO12011000: 656.2, HO17050750: 213.31, HO21013750: 14000.37, KNQ074: 1039.19, KNQ160: 118.78, KNQ196: 2675.06, KNQBP1010: 99.31, KNQCP005: 145.01, NQ1017: 3.14, NQ1161: 188.05, NQ1227: 269, NQ1380: 169.3, NQ1386: 8.38, NQ2064: 0.46, NQ2066: 2.15, NQ2114: 5400, NQ2784: 27.08, NQ2886: 36, NYNUT: 0.82, PNQ082: 7247.71, QCA00003: 108.36, "SYSH-2750-3": 19444.62 };
    expect(Object.keys(prices)).toHaveLength(24);
    for (const [sku, price] of Object.entries(prices)) {
      const o = normaliseOption(fresh({ ...live, Cost: price }), noBasis);
      const sel = selectSupplier([o]);
      expect([sku, sel.status, o.zarUnitCents]).toEqual([sku, "SELECTED", Math.round(price * 100)]);
    }
  });
});
