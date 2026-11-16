import { describe, expect, it } from "vitest";
import { emptyCommercialSettings, parseCommercialSettings, unresolvedItems, validateCommercialSettings, type CommercialSettings } from "../commercial-settings";
import { autoCostFor, isFlag, mergeAutoEntries, NEUTRAL_FLAG_TEXT, toCostE7, type AutoCostEntry } from "../auto-costing";
import type { MasterSupplier, SurveyInput } from "../cost-survey";
import { applyPricingSubmission, createEstimatorPriceSource, submissionFrom, type PricingSubmission } from "../estimator";
import { LEGACY_RULE_VERSION, selectRuleVersion, SUPPLIER_AUTO_RULE_VERSION, calculatePricing, landedCentsE7, withMarkupBps, type PricingScenario } from "../model";

// ALL NUMBERS BELOW ARE FICTITIOUS TEST FIGURES. None is a NewQuip commercial rate.
const NOW = "2026-11-16T09:00:00Z";
const master = new Map<string, MasterSupplier>([["E1", { id: "E1", name: "Test EUR Supplier", currency: "EUR", active: true }], ["Z1", { id: "Z1", name: "Test ZAR Supplier", currency: "ZAR", active: true }]]);
const raw = (sku: string, supplierId: string, cost: number | null, lastSupplied: string | null): SurveyInput => ({ sku, found: true, productStatus: "Active", productName: sku, uom: "Item", averageCost: null, unitFields: {}, suppliers: [{ supplierId, supplierName: supplierId, cost, fixedCost: null, currency: null, lastSupplied }] });
const settings = (over: Partial<CommercialSettings> = {}): CommercialSettings => ({
  ...emptyCommercialSettings(),
  freight: { factorMicro: 1_150_000, addOnCents: 500, source: "test freight policy" },
  fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-16T07:00:00Z" } },
  ...over,
});
const REF = { version: 7, enteredBy: "manager@test" };
const entry = (i: SurveyInput, s: CommercialSettings | null = settings()): AutoCostEntry => { const r = autoCostFor(i, master, s, REF, NOW); if (isFlag(r)) throw new Error(`flag ${r.code}`); return r; };

describe("commercial settings: never invent a commercial value", () => {
  it("a fresh record has NO freight, NO exchange rate and a null (default) markup", () => {
    const s = emptyCommercialSettings();
    expect(s.freight).toBeNull(); expect(s.fx).toEqual({}); expect(s.markupBps).toBeNull();
    expect(validateCommercialSettings(s, NOW)).toEqual([]);
  });
  it("lists every unresolved item and never fills a gap", () => {
    const u = unresolvedItems(null, NOW, ["EUR"]);
    expect(u.map((x) => x.code)).toEqual(["freight_not_set", "fx_missing_currency", "markup_default"]);
    expect(u.find((x) => x.code === "markup_default")!.text).toMatch(/not approved policy/i);
    expect(u.find((x) => x.code === "freight_not_set")!.severity).toBe("blocking");
  });
  it("flags an exchange rate older than the maximum age", () => {
    const s = settings({ fxMaxAgeDays: 1, fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-10T07:00:00Z" } } });
    expect(unresolvedItems(s, NOW).map((x) => x.text)).toContain("EUR exchange rate is older than 1 day.");
    expect(unresolvedItems(settings(), NOW).map((x) => x.code)).toEqual(["markup_default"]);
  });
  it("validates bands, rates, dates and rejects reserved keys; parse keeps only known keys", () => {
    const bad = settings({ ageBands: [{ fromYears: 0, toYears: 1, rateBps: 0 }, { fromYears: 2, toYears: null, rateBps: 100 }] });
    expect(validateCommercialSettings(bad, NOW).join(" ")).toMatch(/start where the previous one ends/);
    expect(validateCommercialSettings(settings({ ageBands: [{ fromYears: 0, toYears: 1, rateBps: 0 }] }), NOW).join(" ")).toMatch(/open-ended/);
    expect(validateCommercialSettings(settings({ fx: { EUR: { rateMicro: 0, source: "x", asOf: "bad" } } }), NOW).length).toBeGreaterThan(1);
    expect(validateCommercialSettings(settings({ fx: { ZAR: { rateMicro: 1_000_000, source: "test", asOf: NOW } } }), NOW).join(" ")).toMatch(/ZAR/);
    expect(validateCommercialSettings(settings({ daysPerYearCenti: 36500 }), NOW).join(" ")).toMatch(/365.25/);
    const p = parseCommercialSettings({ ...settings(), extra: "x", fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-16T07:00:00Z", junk: 1 }, __proto__x: 1 } }, NOW);
    expect(p.ok).toBe(true);
    expect(parseCommercialSettings({ ...settings(), freight: { factorMicro: "1.1" } }, NOW).ok).toBe(false);
    expect(parseCommercialSettings("nope", NOW).ok).toBe(false);
  });
});

describe("automatic costing from Cin7: no price without every commercial input", () => {
  it("MISSING FREIGHT policy: no entry, flagged, with Rep-safe neutral text", () => {
    const r = autoCostFor(raw("A", "E1", 10, "2026-06-16"), master, settings({ freight: null }), REF, NOW);
    expect(isFlag(r) && r.code).toBe("settings_incomplete");
    expect(NEUTRAL_FLAG_TEXT.settings_incomplete).toBe("Price pending: commercial settings incomplete");
    expect(autoCostFor(raw("A", "E1", 10, "2026-06-16"), master, null, REF, NOW)).toMatchObject({ code: "settings_incomplete" });
  });
  it("MISSING / STALE exchange rate: no entry, flagged", () => {
    expect(autoCostFor(raw("A", "E1", 10, "2026-06-16"), master, settings({ fx: {} }), REF, NOW)).toMatchObject({ code: "fx_missing" });
    expect(autoCostFor(raw("A", "E1", 10, "2026-06-16"), master, settings({ fx: { EUR: { rateMicro: 20_000_000, source: "test fixing", asOf: "2026-11-01T00:00:00Z" } } }), REF, NOW)).toMatchObject({ code: "fx_stale" });
  });
  it("no Cin7 cost / undated / future-dated / over the maximum age / zero cost all give NO price", () => {
    expect(autoCostFor({ ...raw("A", "E1", 10, "2026-06-16"), found: false, suppliers: [] }, master, settings(), REF, NOW)).toMatchObject({ code: "no_cost" });
    expect(autoCostFor(raw("A", "E1", 0, "2026-06-16"), master, settings(), REF, NOW)).toMatchObject({ code: "no_cost" });
    expect(autoCostFor(raw("A", "E1", 10, null), master, settings(), REF, NOW)).toMatchObject({ code: "cost_needs_review" });
    expect(autoCostFor(raw("A", "E1", 10, "2027-01-01"), master, settings(), REF, NOW)).toMatchObject({ code: "cost_needs_review" });
    expect(autoCostFor(raw("A", "E1", 10, "2020-01-01"), master, settings(), REF, NOW)).toMatchObject({ code: "cost_too_old" });
  });
  it("a cost with more than 7 decimals is refused, never rounded", () => {
    expect(toCostE7(6.5454755)).toBe(65_454_755);
    expect(toCostE7(1.23456789)).toBeNull();
    expect(toCostE7(-1)).toBeNull();
    expect(autoCostFor(raw("A", "E1", 1.23456789, "2026-06-16"), master, settings(), REF, NOW)).toMatchObject({ code: "cost_precision" });
  });
  it("a ZAR supplier needs no exchange rate; the entry is marked auto, unverified-by-construction, with provenance", () => {
    const e = entry(raw("Z", "Z1", 100, "2026-06-16"), settings({ fx: {} }));
    expect(e.input).toMatchObject({ currency: "ZAR", costKind: "cin7_auto", currencySource: "cin7_supplier", costDate: "2026-06-16" });
    expect(e.input.source).toMatch(/commercial settings v7/);
    expect(e.provenance).toMatchObject({ origin: "auto_cin7", settingsVersion: 7, escalationBps: 0, lastSupplied: "2026-06-16" });
  });
  it("applies the age escalation to the native cost exactly (1279 days old, about 3.5 years: +35.03%)", () => {
    const e = entry(raw("A", "E1", 10, "2023-05-17"), settings());
    expect(e.provenance.ageDays).toBe(1279);
    expect(e.provenance.escalationBps).toBe(3503); // 1000 + 1500 + 2000 x 18325 / 36525 (1003.4)
    expect(e.input.nativeUnitCostE7).toBe(Math.round((100_000_000 * 13_503) / 10_000));
  });
});

describe("PARITY: the Rep's automatic price IS the Estimator path's price (one calculator)", () => {
  const SKU_E = raw("EUR-1", "E1", 10, "2026-06-16"); // < 1 year old: no escalation
  const build = (s: CommercialSettings): PricingSubmission => mergeAutoEntries(null, [entry(SKU_E, s)], s, REF, SUPPLIER_AUTO_RULE_VERSION.id);
  const apply = (sub: PricingSubmission, email: string) => { const r = applyPricingSubmission(undefined, sub, { roles: new Set(["estimator"]), canSeeCost: true }, email, NOW, "test", "project"); if (!r.ok) throw new Error(r.errors.join("; ")); return r.next!; };

  it("same inputs through the same apply + price-source give the same cents, equal to the independent exact arithmetic", () => {
    const sub = build(settings({ markupBps: 2500 }));
    const auto = createEstimatorPriceSource(apply(sub, "auto-pricing"));
    const est = createEstimatorPriceSource(apply(structuredClone(sub), "estimator@test")); // an Estimator entering the identical inputs
    const a = auto.priceFor("EUR-1", "project"), b = est.priceFor("EUR-1", "project");
    expect(a).toEqual(b);
    const landed = landedCentsE7(100_000_000, 20_000_000, 1_150_000) + 500; // 10 EUR x 20 x 1.15 + R5.00 = 23500
    expect(a).toEqual({ status: "priced", unitPriceExVat: withMarkupBps(landed, 2500) / 100, landedCostExVat: landed / 100 });
    expect(landed).toBe(23_500);
  });
  it("a markup left on the default uses the version's value; a Manager markup is an attributed project markup", () => {
    expect(build(settings()).projectMarkup).toBeNull();
    expect(build(settings({ markupBps: 3000 })).projectMarkup).toMatchObject({ markupBps: 3000 });
    const p = apply(build(settings()), "auto-pricing");
    expect(createEstimatorPriceSource(p).priceFor("EUR-1", "project")).toMatchObject({ unitPriceExVat: withMarkupBps(23_500, SUPPLIER_AUTO_RULE_VERSION.markupBps) / 100 });
  });
  it("the auto cost is UNVERIFIED (a Manager must verify it independently) and keeps the unverified flag in the result", () => {
    const p = apply(build(settings()), "auto-pricing");
    const sc: PricingScenario = { pricingDate: NOW, fxQuotes: p.fxQuotes, forwardCover: p.forwardCover, projectMarkup: p.projectMarkup, projectAdjustment: null, itemOverrides: {}, lines: [{ key: "EUR-1", label: "EUR-1", sku: "EUR-1", quantity: 1, cost: { ...p.skus["EUR-1"]!, verification: "unverified" }, freight: p.skus["EUR-1"]!.freight }] };
    const r = calculatePricing(sc, SUPPLIER_AUTO_RULE_VERSION);
    expect(r.priceCompleteness).toBe("provisional");
    expect(r.costsVerified).toBe(false);
  });
  it("idempotent and never overwrites: merging again changes nothing, and an existing (Estimator) entry survives", () => {
    const s = settings();
    const once = build(s);
    const estimatorOwn = structuredClone(once); estimatorOwn.skus["EUR-1"] = { ...estimatorOwn.skus["EUR-1"], nativeUnitCostE7: 999, costKind: "supplier_quotation", source: "Estimator quote Q1" };
    expect(mergeAutoEntries(once, [entry(SKU_E, s)], s, REF, SUPPLIER_AUTO_RULE_VERSION.id)).toEqual(once);
    expect(mergeAutoEntries(estimatorOwn, [entry(SKU_E, s)], s, REF, SUPPLIER_AUTO_RULE_VERSION.id).skus["EUR-1"]).toMatchObject({ nativeUnitCostE7: 999, costKind: "supplier_quotation" });
    const p = apply(once, "auto-pricing");
    expect(submissionFrom(p).skus["EUR-1"]!.costKind).toBe("cin7_auto"); // survives the form round-trip
  });
  it("a line with NO freight is not priced under the new rules (block) but is still priced, flagged, by legacy (unchanged)", () => {
    const base: PricingScenario = { pricingDate: NOW, fxQuotes: {}, forwardCover: {}, projectMarkup: null, projectAdjustment: null, itemOverrides: {}, lines: [{ key: "k", label: "k", sku: "k", quantity: 1, cost: { supplierId: null, supplierName: null, currency: "ZAR", nativeUnitCostE7: 100_000_000, verification: "unverified", source: "test" }, freight: null }] };
    expect(calculatePricing(base, SUPPLIER_AUTO_RULE_VERSION).lines[0].status).toBe("not_priced");
    expect(calculatePricing(base, SUPPLIER_AUTO_RULE_VERSION).issues.map((i) => i.code)).toContain("freight_blocked");
    expect(calculatePricing(base, LEGACY_RULE_VERSION).lines[0]).toMatchObject({ status: "priced", unitPriceCents: 1_200 });
  });
});

describe("rule versions are versioned: legacy-poc-v1 is untouched", () => {
  it("legacy values are pinned and it is still the default", () => {
    expect(LEGACY_RULE_VERSION).toMatchObject({ id: "legacy-poc-v1", status: "legacy", markupBps: 2000, freightUnspecified: "flag", spotRateMaxAgeHours: 24, unverifiedCost: "flag" });
    expect(selectRuleVersion(undefined)).toMatchObject({ ok: true, rules: { id: "legacy-poc-v1" } });
    expect(selectRuleVersion(null)).toMatchObject({ ok: true, rules: { id: "legacy-poc-v1" } });
  });
  it("the new version is provisional (never 'approved'), blocks unspecified freight and takes its age rule from settings", () => {
    expect(SUPPLIER_AUTO_RULE_VERSION).toMatchObject({ id: "newquip-supplier-v1", status: "provisional", freightUnspecified: "block", spotRateMaxAgeHours: null });
    expect(selectRuleVersion("newquip-supplier-v1").ok).toBe(true);
    expect(selectRuleVersion("nope").ok).toBe(false);
  });
});
