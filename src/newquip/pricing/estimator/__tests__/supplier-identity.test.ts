import { describe, expect, it } from "vitest";
import type { PricingSubmission } from "../apply";
import { costToE7, priceAge, validateSupplierIdentities, type Cin7ProductSupplierRef, type Cin7SupplierRef, type IdentityLookups, type Lookup } from "../supplier-identity";

const NOW = "2026-11-17T08:00:00Z";
const sub = (skus: PricingSubmission["skus"]): PricingSubmission => ({ ruleVersionId: "r", skus, fxQuotes: {}, forwardCover: {}, skuPriceOverrides: {}, projectMarkup: null, targetAdjustment: null });
const entry = (over: Record<string, unknown> = {}): PricingSubmission["skus"][string] => ({ supplierId: "S1", supplierName: "Euro Mats", currency: "EUR", nativeUnitCostE7: 268_440_995, source: "Quote Q-77", freight: { factorMicro: 1_100_000, source: "x" }, currencySource: "cin7_supplier", costKind: "supplier_quotation", costDate: "2026-11-10", ...over } as never);
const suppliers: Record<string, Cin7SupplierRef> = {
  S1: { id: "S1", name: "Euro Mats", currency: "EUR", active: true },
  S2: { id: "S2", name: "No Currency Co", currency: null, active: true },
  S3: { id: "S3", name: "Old Co", currency: "ZAR", active: false },
};
const lookups = (over: { suppliers?: Lookup<Cin7SupplierRef | null> | "throw"; product?: Lookup<Cin7ProductSupplierRef[] | null> } = {}): IdentityLookups => ({
  supplier: async (id) => (over.suppliers && over.suppliers !== "throw" ? over.suppliers : { status: "ok", value: suppliers[id] ?? null }),
  productSuppliers: async () => over.product ?? { status: "ok", value: [{ supplierId: "S1", supplierName: "Euro Mats", cost: 26.8440995, currency: "EUR", lastSupplied: "2026-03-02" }] },
});
const run = (skus: PricingSubmission["skus"], base: PricingSubmission | null = null, l: IdentityLookups = lookups()) => validateSupplierIdentities({ submission: sub(skus), base, lookups: l, nowIso: NOW });

describe("a new or changed supplier cost must name an active Cin7 supplier by id", () => {
  it("accepts a quotation from a Cin7 supplier whose currency comes from its Cin7 record", async () => {
    expect(await run({ ERT053: entry() })).toEqual([]);
  });
  it("refuses a cost with no supplier id, however the name is typed", async () => {
    expect(await run({ ERT053: entry({ supplierId: null }) })).toEqual(["ERT053: choose the supplier from Cin7 (search by name)."]);
    expect(await run({ ERT053: entry({ supplierId: "", supplierName: "Euro Mats" }) })).toEqual(["ERT053: choose the supplier from Cin7 (search by name)."]);
  });
  it("refuses an unknown or inactive supplier id", async () => {
    expect((await run({ A: entry({ supplierId: "NOPE" }) }))[0]).toMatch(/not an active supplier in Cin7/);
    expect((await run({ A: entry({ supplierId: "S3", supplierName: "Old Co", currency: "ZAR" }) }))[0]).toMatch(/not an active supplier in Cin7/);
  });
  it("a supplier whose id is right but whose name was edited is refused (the id is the identity; the label must still match)", async () => {
    expect((await run({ A: entry({ supplierName: "Someone Else" }) }))[0]).toMatch(/does not match Cin7 \(Euro Mats\)/);
  });
});

describe("currency is derived from Cin7, never typed, never defaulted", () => {
  it("a currency that differs from the Cin7 supplier record is refused", async () => {
    expect((await run({ A: entry({ currency: "USD" }) }))[0]).toMatch(/Cin7 holds EUR for Euro Mats, not USD/);
  });
  it("Cin7 holds no currency: the derived path is refused (never silently ZAR) and the override needs a reason", async () => {
    const derived = await run({ A: entry({ supplierId: "S2", supplierName: "No Currency Co", currency: "ZAR" }) });
    expect(derived[0]).toMatch(/Cin7 holds no currency for No Currency Co/);
    const override = await run({ A: entry({ supplierId: "S2", supplierName: "No Currency Co", currency: "USD", currencySource: "override", currencyOverrideReason: "Cin7 supplier record has no currency; invoices are in USD (see quote)." }) });
    expect(override).toEqual([]);
  });
  it("an override is refused when Cin7 DOES hold a currency", async () => {
    expect((await run({ A: entry({ currencySource: "override", currencyOverrideReason: "I prefer another currency here." }) }))[0]).toMatch(/Cin7 already holds EUR.*cannot be overridden/);
  });
  it("a cost with no stated currency basis or no cost kind is refused", async () => {
    expect((await run({ A: entry({ currencySource: undefined }) }))[0]).toMatch(/currency must come from the Cin7 supplier record/);
    expect((await run({ A: entry({ costKind: undefined }) }))[0]).toMatch(/what kind of cost/);
  });
  it("when Cin7 cannot be read nothing is accepted (no guess), with one plain message", async () => {
    expect(await run({ A: entry() }, null, lookups({ suppliers: { status: "unavailable" } }))).toEqual([expect.stringMatching(/could not be read just now/)]);
  });
});

describe("the kind of cost is kept distinct", () => {
  it("a supplier quotation needs its date, which cannot be in the future", async () => {
    expect((await run({ A: entry({ costDate: null }) }))[0]).toMatch(/enter the date of the supplier quotation/);
    expect((await run({ A: entry({ costDate: "2026-12-01" }) }))[0]).toMatch(/cannot be in the future/);
  });
  it("a Cin7 historical cost must be exactly Cin7's price from that supplier, with Cin7's last-supplied date (or none when Cin7 has none)", async () => {
    const ok = entry({ costKind: "cin7_historical", costDate: "2026-03-02", source: "Cin7 latest supplier price" });
    expect(await run({ ERT053: ok })).toEqual([]);
    expect((await run({ ERT053: { ...ok, nativeUnitCostE7: 270_000_000 } }))[0]).toMatch(/not the Cin7 price \(26.8440995\)/);
    expect((await run({ ERT053: { ...ok, costDate: "2026-11-01" } }))[0]).toMatch(/last-supplied date \(2026-03-02\)/);
    const undated = lookups({ product: { status: "ok", value: [{ supplierId: "S1", supplierName: "Euro Mats", cost: 26.8440995, currency: "EUR", lastSupplied: null }] } });
    expect(await run({ ERT053: { ...ok, costDate: null } }, null, undated)).toEqual([]); // an undated Cin7 cost stays undated: no invented date
    expect((await run({ ERT053: { ...ok, costDate: "2026-11-01" } }, null, undated))[0]).toMatch(/Cin7 holds none, so the date stays blank/);
  });
  it("a historical cost for a supplier Cin7 does not list for the product is refused", async () => {
    const other = lookups({ product: { status: "ok", value: [{ supplierId: "S9", supplierName: "Other", cost: 1, currency: "ZAR", lastSupplied: null }] } });
    expect((await run({ A: entry({ costKind: "cin7_historical", costDate: null }) }, null, other))[0]).toMatch(/holds no price from Euro Mats for this product/);
  });
  it("a manual estimate needs no date and no Cin7 price", async () => {
    expect(await run({ A: entry({ costKind: "manual_estimate", costDate: null, source: "Estimated from similar product NQ1161" }) })).toEqual([]);
  });
});

describe("changed versus unchanged", () => {
  it("an entry identical to the base is not re-checked (older entries without a supplier id keep working)", async () => {
    const legacy = entry({ supplierId: null, currencySource: undefined, costKind: undefined, costDate: undefined });
    expect(await run({ A: legacy }, sub({ A: legacy }))).toEqual([]);
  });
  it("changing the supplier of an existing cost re-checks it (and so voids any earlier verification through the cost hash)", async () => {
    const base = sub({ A: entry() });
    expect((await run({ A: entry({ supplierId: "S2", supplierName: "No Currency Co" }) }, base))[0]).toMatch(/Cin7 holds no currency for No Currency Co/);
  });
  it("costToE7 is exact", () => {
    expect(costToE7(6.5454755)).toBe(65_454_755);
    expect(costToE7(193.6)).toBe(1_936_000_000);
    expect(costToE7(0.95)).toBe(9_500_000);
  });
});

describe("the age of a dated Cin7 price is information only", () => {
  it("is measured from Cin7's last-supplied date; 12 months or more is 'stale' (a prompt to confirm, never a calculation)", () => {
    expect(priceAge("2026-11-01", "2026-11-17T08:00:00Z")).toEqual({ months: 0, stale: false, text: "less than a month ago" });
    expect(priceAge("2026-03-02", "2026-11-17T08:00:00Z")).toMatchObject({ months: 8, stale: false, text: "8 months ago" });
    expect(priceAge("2025-11-01", "2026-11-17T08:00:00Z")).toMatchObject({ months: 12, stale: true });
    expect(priceAge("2023-01-05", "2026-11-17T08:00:00Z")).toMatchObject({ stale: true, text: "3 years ago" });
  });
  it("an undated price has NO age (nothing is guessed), and a future or malformed date is unknown", () => {
    expect(priceAge(null, "2026-11-17T08:00:00Z")).toBeNull();
    expect(priceAge("2027-01-01", "2026-11-17T08:00:00Z")).toBeNull();
    expect(priceAge("last year", "2026-11-17T08:00:00Z")).toBeNull();
  });
});

