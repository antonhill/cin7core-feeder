import { describe, expect, it } from "vitest";
import { ageYears, classifySku, compoundFactor, coverage, pickUnitFields, simpleFactor, type MasterSupplier, type SurveyInput } from "../cost-survey";

const TODAY = "2026-11-16";
const master = new Map<string, MasterSupplier>([
  ["E1", { id: "E1", name: "ERRA TECNI-RAM SL", currency: "EUR", active: true }],
  ["Z1", { id: "Z1", name: "Local Co", currency: "ZAR", active: true }],
  ["N1", { id: "N1", name: "No Ccy", currency: null, active: true }],
  ["X1", { id: "X1", name: "Old Co", currency: "ZAR", active: false }],
]);
const input = (over: Partial<SurveyInput> & { suppliers: SurveyInput["suppliers"] }): SurveyInput => ({ sku: "S", found: true, productStatus: "Active", productName: "p", uom: "Item", averageCost: null, unitFields: {}, ...over });
const rec = (id: string, cost: number | null, date: string | null, ccy: string | null = null) => ({ supplierId: id, supplierName: id, cost, fixedCost: null, currency: ccy, lastSupplied: date });

describe("age and the marginal bands (the owner-approved rules)", () => {
  it("age is elapsed days / 365.25; a future date has no age", () => {
    expect(ageYears("2025-11-16", TODAY)).toBeCloseTo(365 / 365.25, 5);
    expect(ageYears("2026-11-17", TODAY)).toBeNull();
  });
  it("marginal simple: 0-1y 0%, 1-2y 10%, 2-3y 15%, over 3y 20%; no cliff at a boundary", () => {
    expect(simpleFactor(1)).toBeCloseTo(1, 9);
    expect(simpleFactor(2)).toBeCloseTo(1.1, 9);
    expect(simpleFactor(3)).toBeCloseTo(1.25, 9);
    expect(simpleFactor(3.01)).toBeCloseTo(1.252, 9); // continuous across the boundary
    expect(simpleFactor(5)).toBeCloseTo(1.65, 9);
  });
  it("marginal compound is applied progressively across the bands", () => {
    expect(compoundFactor(1)).toBeCloseTo(1, 9);
    expect(compoundFactor(2)).toBeCloseTo(1.1, 9);
    expect(compoundFactor(3)).toBeCloseTo(1.1 * 1.15, 9);
    expect(compoundFactor(5)).toBeCloseTo(1.1 * 1.15 * 1.2 * 1.2, 9);
  });
});

describe("classification", () => {
  it("a recent dated cost from an active supplier with a Cin7 currency is READY (observed: ERT053, EUR, 2026-11-13)", () => {
    const r = classifySku(input({ sku: "ERT053", averageCost: 494.46, suppliers: [rec("E1", 26.8440995, "2026-11-13", null)] }), master, TODAY);
    expect(r).toMatchObject({ tier: "ready", reasons: [], currency: "EUR", fxNeeded: true, band: "0-1y (0%)", averageCostReference: 494.46 });
    expect(r.simpleFactor).toBe(1);
  });
  it("a dated 1-5 year cost is HISTORICAL (priceable once the policy is approved), over 5 years needs a fresh quote", () => {
    expect(classifySku(input({ suppliers: [rec("Z1", 10, "2024-06-01", "ZAR")] }), master, TODAY)).toMatchObject({ tier: "historical", band: "2-3y (15%)", fxNeeded: false });
    expect(classifySku(input({ suppliers: [rec("Z1", 10, "2020-01-01")] }), master, TODAY)).toMatchObject({ tier: "review", reasons: ["older_than_maximum"] });
  });
  it("undated, future-dated and same-date conflicts need review; the newest dated record wins otherwise", () => {
    expect(classifySku(input({ suppliers: [rec("Z1", 10, null)] }), master, TODAY).reasons).toEqual(["undated"]);
    expect(classifySku(input({ suppliers: [rec("Z1", 10, "2027-01-01")] }), master, TODAY).reasons).toEqual(["future_dated"]);
    expect(classifySku(input({ suppliers: [rec("Z1", 10, "2026-05-01"), rec("E1", 12, "2026-05-01")] }), master, TODAY).reasons).toEqual(["ambiguous_same_date"]);
    const r = classifySku(input({ suppliers: [rec("Z1", 10, "2025-01-01"), rec("E1", 12, "2026-05-01")] }), master, TODAY);
    expect(r).toMatchObject({ tier: "ready", selected: { supplierId: "E1", cost: 12 }, multipleSuppliers: true });
  });
  it("missing: no product, inactive product, no supplier record, zero or negative costs (never priced at zero)", () => {
    expect(classifySku(input({ found: false, suppliers: [] }), master, TODAY)).toMatchObject({ tier: "missing", reasons: ["not_in_cin7"] });
    expect(classifySku(input({ productStatus: "Deprecated", suppliers: [rec("Z1", 5, "2026-01-01")] }), master, TODAY).reasons).toEqual(["product_inactive"]);
    expect(classifySku(input({ suppliers: [] }), master, TODAY).reasons).toEqual(["no_supplier_record"]);
    expect(classifySku(input({ suppliers: [rec("Z1", 0, "2026-01-01"), rec("E1", null, null)] }), master, TODAY)).toMatchObject({ tier: "missing", reasons: ["no_positive_cost"], zeroOrNegative: 2 });
  });
  it("currency: none anywhere, or a record that disagrees with the supplier master, needs review; an inactive or unknown supplier needs review", () => {
    expect(classifySku(input({ suppliers: [rec("N1", 5, "2026-10-01")] }), master, TODAY).reasons).toEqual(["currency_unknown"]);
    expect(classifySku(input({ suppliers: [rec("E1", 5, "2026-10-01", "USD")] }), master, TODAY).reasons).toEqual(["currency_conflict"]);
    expect(classifySku(input({ suppliers: [rec("X1", 5, "2026-10-01")] }), master, TODAY).reasons).toEqual(["supplier_unknown_or_inactive"]);
    expect(classifySku(input({ suppliers: [rec("GONE", 5, "2026-10-01")] }), master, TODAY).reasons).toContain("supplier_unknown_or_inactive");
  });
  it("a supplier whose own Cin7 record holds no currency is review even when the product record states one (the master is the authority)", () => {
    const r = classifySku(input({ suppliers: [rec("N1", 5, "2026-10-01", "USD")] }), master, TODAY);
    expect(r).toMatchObject({ tier: "review", reasons: ["currency_unknown"], currency: null, fxNeeded: false });
  });
  it("records the rule ignores are flagged: undated/future siblings beside a dated winner, and a newer zero-cost record", () => {
    expect(classifySku(input({ suppliers: [rec("Z1", 10, "2026-09-01"), rec("E1", 12, null)] }), master, TODAY).reasons).toEqual(["ignored_sibling_records"]);
    expect(classifySku(input({ suppliers: [rec("Z1", 10, "2025-09-01"), rec("E1", 0, "2026-09-01")] }), master, TODAY).reasons).toEqual(["newer_non_positive_record"]);
  });
  it("the average cost is reference only: it never makes a SKU priceable", () => {
    expect(classifySku(input({ averageCost: 99, suppliers: [] }), master, TODAY)).toMatchObject({ tier: "missing", averageCostReference: 99, selected: null });
  });
});

describe("coverage and unit evidence", () => {
  it("counts tiers, reasons, bands and foreign currencies", () => {
    const rs = [
      classifySku(input({ sku: "a", suppliers: [rec("E1", 1, "2026-11-01")] }), master, TODAY),
      classifySku(input({ sku: "b", suppliers: [rec("Z1", 1, "2024-06-01")] }), master, TODAY),
      classifySku(input({ sku: "c", suppliers: [rec("Z1", 1, null)] }), master, TODAY),
      classifySku(input({ sku: "d", suppliers: [] }), master, TODAY),
    ];
    expect(coverage(rs)).toMatchObject({ total: 4, ready: 1, historical: 1, review: 1, missing: 1, undated: 1, fxNeeded: 1, foreignCurrencies: { EUR: 1 } });
  });
  it("picks only unit-like scalar fields", () => {
    expect(pickUnitFields({ UOM: "Item", Name: "x", PurchaseUnit: "Box", ConversionFactor: 6, Cost: 3, nested: { Unit: 1 } })).toEqual({ UOM: "Item", PurchaseUnit: "Box", ConversionFactor: 6 });
  });
});
