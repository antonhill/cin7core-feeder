import { describe, expect, it } from "vitest";
import { autoCostFor, isFlag, type AutoCostEntry } from "../auto-costing";
import { canPriceAnything, emptyCommercialSettings, parseCommercialSettings, resolveFreight, unresolvedItems, validateCommercialSettings, type CommercialSettings } from "../commercial-settings";
import type { SurveyInput } from "../cost-survey";

// TEST-ONLY freight assumptions agreed for acceptance testing (bulk tank 1.30, feeder 1.25): NOT approved NewQuip policy. All figures are fixtures.
const NOW = "2026-11-17T12:00:00Z";
const FX = { rateMicro: 18_000_000, source: "TEST-ONLY rate", asOf: "2026-11-17T08:00:00Z", origin: "oxr" as const };
const S = (over: Partial<CommercialSettings> = {}): CommercialSettings => ({
  ...emptyCommercialSettings(), markupBps: 2500, fxMaxAgeDays: 1,
  fx: { USD: FX, EUR: { ...FX, rateMicro: 20_000_000 } },
  freightByCategory: { bulk_tank: { factorMicro: 1_300_000, addOnCents: 0, source: "TEST-ONLY bulk tank freight" }, feeder: { factorMicro: 1_250_000, addOnCents: 0, source: "TEST-ONLY feeder freight" } },
  ...over,
});
const raw = (sku: string, cost: number, ccy: string): SurveyInput => ({ sku, found: true, productStatus: "Active", productName: sku, uom: null, averageCost: null, unitFields: {}, suppliers: [{ supplierId: "S1", supplierName: "Sup", cost, fixedCost: null, currency: ccy, lastSupplied: "2026-11-13" }] });
const master = new Map([["S1", { id: "S1", name: "Sup", currency: "USD", active: true }]]);
const REF = { version: 3, enteredBy: "mgr@nq" };
const entry = (x: ReturnType<typeof autoCostFor>): AutoCostEntry => { if (isFlag(x)) throw new Error(`flag ${x.code}: ${x.internal}`); return x; };

describe("freight by product category (TEST-ONLY assumptions; never a silent 1.0)", () => {
  it("resolves category first, then the explicit default, else NONE", () => {
    expect(resolveFreight(S(), ["bulk_tank"])).toMatchObject({ ok: true, category: "bulk_tank", policy: { factorMicro: 1_300_000 } });
    expect(resolveFreight(S({ freight: { factorMicro: 1_150_000, addOnCents: 0, source: "TEST-ONLY default" } }), ["concrete_slat"])).toMatchObject({ ok: true, category: null, policy: { factorMicro: 1_150_000 } });
    expect(resolveFreight(S(), ["concrete_slat"])).toEqual({ ok: false, reason: "not_set", categories: ["concrete_slat"] });
    expect(resolveFreight(S(), ["bulk_tank", "feeder"])).toMatchObject({ ok: false, reason: "conflict" });
  });
  it("USD bulk tank takes its category factor 1.30 (the rand landed cost and selling price are checked end to end in the browser run)", () => {
    const e = entry(autoCostFor(raw("SYSH-2750-3", 1174.51, "USD"), master, S(), REF, NOW, ["bulk_tank"]));
    expect(e.input.freight).toMatchObject({ factorMicro: 1_300_000 }); expect(e.input.freight!.source).toContain("(bulk_tank)");
    expect(e.input).toMatchObject({ currency: "USD", nativeUnitCostE7: 11_745_100_000, costKind: "cin7_auto" });
  });
  it("feeder at 1.25; a product in no category and with no default is an exception that names the category, not a price", () => {
    expect(entry(autoCostFor(raw("PNQ082", 393.48, "USD"), master, S(), REF, NOW, ["feeder"])).input.freight).toMatchObject({ factorMicro: 1_250_000 });
    const f = autoCostFor(raw("NQ1161", 188.05, "USD"), master, S(), REF, NOW, ["concrete_slat"]);
    expect(isFlag(f) && f.code).toBe("freight_not_set"); expect(isFlag(f) && f.internal).toMatch(/concrete_slat/);
    const c = autoCostFor(raw("X", 1, "USD"), master, S(), REF, NOW, ["bulk_tank", "feeder"]);
    expect(isFlag(c) && c.code).toBe("freight_conflict");
  });
  it("category-only settings can price (canPriceAnything) and say so honestly in the unresolved list; no freight at all prices nothing", () => {
    expect(canPriceAnything(S())).toBe(true);
    expect(unresolvedItems(S(), NOW).some((u) => u.code === "freight_default_not_set")).toBe(true);
    expect(canPriceAnything(S({ freightByCategory: {} }))).toBe(false);
  });
  it("validates and round-trips freightByCategory and fx origin/retrievedAt; rejects bad keys and factors", () => {
    const s = S({ fx: { USD: { ...FX, retrievedAt: "2026-11-17T11:59:00Z" } } });
    expect(validateCommercialSettings(s, NOW)).toEqual([]);
    const p = parseCommercialSettings(JSON.parse(JSON.stringify(s)), NOW);
    expect(p.ok && p.value.freightByCategory.feeder.factorMicro).toBe(1_250_000); expect(p.ok && p.value.fx.USD.origin).toBe("oxr");
    expect(validateCommercialSettings(S({ freightByCategory: { "Bad Key": { factorMicro: 1, addOnCents: 0, source: "xxx" } } }), NOW).join()).toMatch(/not a valid freight category/);
    expect(validateCommercialSettings(S({ freightByCategory: { feeder: { factorMicro: 0, addOnCents: 0, source: "xxx" } } }), NOW).join()).toMatch(/feeder freight factor/);
    expect(parseCommercialSettings({ ...JSON.parse(JSON.stringify(emptyCommercialSettings())) }, NOW).ok).toBe(true); // older blocks without categories still parse
  });
});
