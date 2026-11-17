import { describe, expect, it } from "vitest";
import { emptyCommercialSettings, type CommercialSettings } from "../commercial-settings";
import { autoCostFor, isFlag, mergeAutoEntries, type AutoCostEntry } from "../auto-costing";
import type { MasterSupplier, SurveyInput } from "../cost-survey";
import { applyPricingSubmission, createEstimatorPriceSource } from "../estimator";
import { SUPPLIER_AUTO_RULE_VERSION } from "../model";

// CONTROLLED FIXTURES. These are NOT real-quotation acceptance and NOT NewQuip commercial rates: every figure below is a TEST-ONLY setting chosen so the arithmetic can be checked by hand
// (USD rate 18.00, freight factor 1.15 with no add-on, markup 25%, owner-approved age bands 0/10/15/20% simple marginal, 365.25-day year, maximum age 5 years). They prove that a USD supplier
// cost (the two figures that were not priced in a connected test: 1174.51 and 6.5454755) goes through the real automatic costing and the real calculator to an exact price, and that the
// historical age escalation moves the price. The expected cents are computed here with an independent BigInt half-up routine, not with the model's own helpers.
const NOW = "2026-11-17T09:00:00Z";
const master = new Map<string, MasterSupplier>([["U1", { id: "U1", name: "Fixture USD Supplier", currency: "USD", active: true }]]);
const raw = (sku: string, cost: number, lastSupplied: string): SurveyInput => ({ sku, found: true, productStatus: "Active", productName: sku, uom: "Item", averageCost: null, unitFields: {}, suppliers: [{ supplierId: "U1", supplierName: "Fixture USD Supplier", cost, fixedCost: null, currency: null, lastSupplied }] });
const SETTINGS: CommercialSettings = {
  ...emptyCommercialSettings(),
  markupBps: 2500,
  freight: { factorMicro: 1_150_000, addOnCents: 0, source: "fixture freight policy" },
  fx: { USD: { rateMicro: 18_000_000, source: "fixture USD fixing", asOf: "2026-11-17T07:00:00Z" } },
};
const REF = { version: 3, enteredBy: "manager@fixture" };

const B = (n: number): bigint => BigInt(n);
const halfUp = (num: bigint, den: bigint): bigint => (num * B(2) + den) / (den * B(2));
/** Independent exact arithmetic: native cost (E7) -> landed cents -> selling cents. */
const expectCents = (costE7: number, escalationBps: number) => {
  const escalated = halfUp(B(costE7) * (B(10_000) + B(escalationBps)), B(10_000));
  const landed = halfUp(escalated * B(18_000_000) * B(1_150_000) * B(100), B(10_000_000) * B(1_000_000) * B(1_000_000));
  const price = halfUp(landed * B(12_500), B(10_000));
  return { escalated, landed, price };
};
const priced = (e: AutoCostEntry) => {
  const sub = mergeAutoEntries(null, [e], SETTINGS, REF, SUPPLIER_AUTO_RULE_VERSION.id);
  const r = applyPricingSubmission(undefined, sub, { roles: new Set(["estimator"]), canSeeCost: true }, "auto-pricing", NOW, "fixture", "project");
  if (!r.ok) throw new Error(r.errors.join("; "));
  return createEstimatorPriceSource(r.next!).priceFor(e.sku, "project");
};
const entryOf = (i: SurveyInput): AutoCostEntry => { const r = autoCostFor(i, master, SETTINGS, REF, NOW); if (isFlag(r)) throw new Error(`flag ${r.code}: ${r.internal}`); return r; };

describe("FIXTURE (not a real quotation): the test-only settings are exactly the owner-approved bands", () => {
  it("bands 0/10/15/20% simple marginal, 365.25-day year, 5-year maximum", () => {
    expect(SETTINGS.ageBands.map((b) => b.rateBps)).toEqual([0, 1000, 1500, 2000]);
    expect(SETTINGS.daysPerYearCenti).toBe(36_525);
    expect(SETTINGS.maxAgeYears).toBe(5);
  });
});

describe("FIXTURE (not a real quotation): USD supplier costs through autoCostFor and the real calculator", () => {
  it("USD 1174.51 (bulk-tank shaped), supplied this year: landed R24,312.36, selling R30,390.45 (cents exact)", () => {
    const e = entryOf(raw("FIX-USD-A", 1174.51, "2026-06-16"));
    expect(e.input).toMatchObject({ currency: "USD", costKind: "cin7_auto", nativeUnitCostE7: 11_745_100_000, currencySource: "cin7_supplier" });
    expect(e.provenance.escalationBps).toBe(0);
    const x = expectCents(11_745_100_000, 0);
    expect(x.landed).toBe(B(2_431_236)); // 1174.51 x 18.00 x 1.15 = 24,312.357
    expect(x.price).toBe(B(3_039_045)); // x 1.25
    expect(priced(e)).toEqual({ status: "priced", unitPriceExVat: 30_390.45, landedCostExVat: 24_312.36 });
  });
  it("USD 6.5454755 (a seven-decimal cost, cup shaped): landed R135.49, selling R169.36 (the cost is held exactly, never rounded)", () => {
    const e = entryOf(raw("FIX-USD-B", 6.5454755, "2026-06-16"));
    expect(e.input.nativeUnitCostE7).toBe(65_454_755);
    const x = expectCents(65_454_755, 0);
    expect(x.landed).toBe(B(13_549)); // 6.5454755 x 18.00 x 1.15 = 135.49134...
    expect(x.price).toBe(B(16_936)); // 135.49 x 1.25 = 169.3625 -> 169.36
    expect(priced(e)).toEqual({ status: "priced", unitPriceExVat: 169.36, landedCostExVat: 135.49 });
  });
  it("a missing USD rate is a flag with a specific reason, never a price", () => {
    const r = autoCostFor(raw("FIX-USD-A", 1174.51, "2026-06-16"), master, { ...SETTINGS, fx: {} }, REF, NOW);
    expect(isFlag(r) && r.code).toBe("fx_missing");
    expect(isFlag(r) && r.internal).toMatch(/USD exchange rate is not set/);
  });
});

describe("FIXTURE (not a real quotation): historical escalation (cost last supplied 2023-05-17, priced 2026-11-17)", () => {
  it("1280 days old = +35.09% (3509 bps) and the priced value follows the escalated cost exactly", () => {
    const e = entryOf(raw("FIX-USD-OLD", 1174.51, "2023-05-17"));
    expect(e.provenance).toMatchObject({ ageDays: 1280, escalationBps: 3509, rawCostE7: 11_745_100_000, lastSupplied: "2023-05-17" });
    const x = expectCents(11_745_100_000, 3509);
    expect(BigInt(e.input.nativeUnitCostE7)).toBe(x.escalated);
    const p = priced(e);
    expect(p).toEqual({ status: "priced", unitPriceExVat: Number(x.price) / 100, landedCostExVat: Number(x.landed) / 100 });
    // and it is strictly dearer than the un-escalated cost, by the escalation
    const fresh = expectCents(11_745_100_000, 0);
    expect(x.price > fresh.price).toBe(true);
    expect(e.input.source).toMatch(/\+35\.09% age escalation over 1280 days/);
  });
  it("older than the 5-year maximum: no price, a specific reason", () => {
    const r = autoCostFor(raw("FIX-USD-OLD", 1174.51, "2021-01-01"), master, SETTINGS, REF, NOW);
    expect(isFlag(r) && r.code).toBe("cost_too_old");
  });
});
