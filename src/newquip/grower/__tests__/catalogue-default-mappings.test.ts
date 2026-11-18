import { describe, expect, it } from "vitest";
import { evaluateDraft } from "../evaluate";
import type { QuoteDraft } from "../draft";
import { readyDraft } from "./golden";
import { testPriceSource } from "./test-snapshot";
import { COMMERCIAL_MAPPINGS, isCatalogueDefaultItem, packageAutoConfirmable, packageFor, type PackageMapping } from "../commercial";
import { effectiveMappings, mappingError } from "../mapping-integrity";
import { DEMO_DEFAULTS } from "../demo-defaults";
import { ESTIMATOR_LINE_STATUSES, ESTIMATOR_PRICING_STATUSES, ownedWork } from "@/newquip/quote/stage1-steps";
import type { PriceSource } from "../pricing-source";

// Established catalogue products (bulk tank, CCM feeder, concrete slat, feed saver mat) resolve by default so an Estimator does not reconfirm them on every quotation.
// Everything ambiguous (cup drinker, LED, door, M75, optional extras) still needs an explicit decision, and mapping readiness stays separate from pricing readiness.

const ctx = { priceSource: testPriceSource(), withholdCost: false };
const DEFAULTS = { bulk_tank: "SYSH-2750-3", feeder: "PNQ082", concrete_slat: "NQ1161", feed_saver_mat: "ERT053" } as const;
const none = (d: QuoteDraft = readyDraft()): QuoteDraft => { const c = structuredClone(d); c.estimator.confirmedMappings = {}; c.estimator.confirmedPackages = []; return c; };
const line = (d: QuoteDraft, k: string, c = ctx) => evaluateDraft(d, c).budget!.lines.find((l) => l.itemKey === k)!;
/** The test price source with some SKUs made unusable. */
const withGaps = (gaps: Record<string, "not_in_source" | "zero">): PriceSource => {
  const base = testPriceSource();
  return { ...base, priceFor: (sku, qt) => (gaps[sku] === "not_in_source" ? { status: "not_in_source", reason: `${sku} is not in the price source.` } : gaps[sku] === "zero" ? { status: "supplier_quote_required", reason: `N/A - supplier quote required for ${sku}.` } : base.priceFor(sku, qt)) };
};

describe("established catalogue mappings are reused without a per-quotation confirmation", () => {
  it("a quotation with NO stored confirmations still resolves the four established products, marked as catalogue defaults", () => {
    const d = none();
    for (const [k, sku] of Object.entries(DEFAULTS)) {
      const l = line(d, k);
      expect(l, k).toMatchObject({ status: "priced", sku, mappingSource: "catalogue_default" });
    }
  });
  it("the CCM feeder follows its variant", () => {
    const d = none(); d.config.feederVariant = "WINDOW";
    expect(line(d, "feeder")).toMatchObject({ status: "priced", sku: "PNQ082-WINDOW", mappingSource: "catalogue_default" });
  });
  it("defaults change no price, quantity or total: the same lines and totals as the explicit confirmations", () => {
    const explicit = evaluateDraft(readyDraft(), ctx).budget!;
    const implicit = evaluateDraft(none(readyDraft()), ctx).budget!;
    for (const k of Object.keys(DEFAULTS)) {
      const a = explicit.lines.find((l) => l.itemKey === k)!; const b = implicit.lines.find((l) => l.itemKey === k)!;
      expect({ q: b.quantity, u: b.unitPrice, r: b.revenueExTax, sku: b.sku }).toEqual({ q: a.quantity, u: a.unitPrice, r: a.revenueExTax, sku: a.sku });
    }
  });
});

describe("explicit confirmations stay authoritative and validated", () => {
  it("an explicit valid confirmation is used and attributed to the Estimator", () => {
    const l = line(readyDraft(), "bulk_tank");
    expect(l).toMatchObject({ status: "priced", sku: "SYSH-2750-3", mappingSource: "estimator" });
  });
  it("an explicit confirmation of a DIFFERENT product is refused, not silently replaced by the default", () => {
    const d = none(); d.estimator.confirmedMappings = { bulk_tank: "SYSH-2750-9" }; // not the default and not an approved alternative (SYSH-2750-4 is, since Sean's 2026-11 answer)
    expect(line(d, "bulk_tank")).toMatchObject({ status: "unmapped", sku: null });
    expect(line(d, "bulk_tank").reason).toMatch(/does not match the expected SYSH-2750-3/);
  });
  it("the door still takes only the Estimator's explicit choice", () => {
    expect(line(none(), "pvc_door")).toMatchObject({ status: "unmapped", sku: null });
    const d = none(); d.estimator.confirmedMappings = { pvc_door: "NQ2114" };
    expect(line(d, "pvc_door")).toMatchObject({ status: "priced", sku: "NQ2114", mappingSource: "estimator" });
  });
});

describe("only the named established items default; everything ambiguous keeps an explicit decision", () => {
  it("the default list is exactly the four items", () => {
    const all = Object.keys(COMMERCIAL_MAPPINGS).concat(["controller", "silo_weighing", "control_panel", "emergency_windows", "pad_cooling", "cone_fans", "manure_plug"]);
    expect(all.filter((k) => isCatalogueDefaultItem(k as never)).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });
  it("cup drinker is NOT auto-confirmed (a later source disputes which representation prices it); LED, M75 and penning are not either", () => {
    expect(packageAutoConfirmable(packageFor("cup_drinker", "grower-2026-11"))).toBe(false);
    expect(packageAutoConfirmable(packageFor("led_light", "grower-2026-11"))).toBe(false);
    expect(packageAutoConfirmable(packageFor("flex_auger", "grower-2026-11"))).toBe(false);
    expect(packageAutoConfirmable(undefined)).toBe(false);
    expect(line(none(), "cup_drinker")).toMatchObject({ status: "package_unconfirmed" });
    const noRes = none(); noRes.estimator.priceResolutions = {};
    expect(line(noRes, "led_light").status).toBe("package_unconfirmed");
  });
  it("a package is auto-confirmable only when its definition is complete, authoritative and undisputed", () => {
    const ok: PackageMapping = { kind: "package", itemKey: "cup_drinker", name: "x", provenance: "x", layoutDriven: false, components: [{ id: "a", sku: "A", description: "a", identity: "source_backed", quantityStatus: "source_fixed", qtyPerUnit: 1, evidence: "e" }] };
    expect(packageAutoConfirmable(ok)).toBe(true);
    expect(packageAutoConfirmable({ ...ok, alternativeIdentity: { sku: "B", description: "b", note: "n" } })).toBe(false);
    expect(packageAutoConfirmable({ ...ok, layoutDriven: true })).toBe(false);
    expect(packageAutoConfirmable({ ...ok, estimatorPriced: true })).toBe(false);
    expect(packageAutoConfirmable({ ...ok, components: [{ ...ok.components[0], sku: null }] })).toBe(false);
    expect(packageAutoConfirmable({ ...ok, components: [{ ...ok.components[0], quantityStatus: "requires_validation", qtyPerUnit: null }] })).toBe(false);
    expect(packageAutoConfirmable({ ...ok, components: [{ ...ok.components[0], identity: "uncertain" }] })).toBe(false);
    expect(packageAutoConfirmable({ ...ok, components: [] })).toBe(false);
  });
  it("optional extras never default", () => {
    for (const k of ["controller", "silo_weighing", "control_panel", "emergency_windows", "pad_cooling", "cone_fans", "manure_plug"]) expect(isCatalogueDefaultItem(k as never)).toBe(false);
  });
});

describe("mapping readiness is separate from pricing readiness", () => {
  it("a defaulted product with no usable price stays blocked as an Estimator COSTING task, never as a product choice", () => {
    const g = { ...ctx, priceSource: withGaps({ ERT053: "not_in_source", NQ1161: "zero" }) };
    const mat = line(none(), "feed_saver_mat", g); const slat = line(none(), "concrete_slat", g);
    expect(mat).toMatchObject({ status: "not_in_price_source", sku: "ERT053", mappingSource: "catalogue_default" });
    expect(slat).toMatchObject({ status: "supplier_quote_required", sku: "NQ1161", mappingSource: "catalogue_default" });
    const ev = evaluateDraft(none(), g);
    expect(ev.readiness.state).toBe("BLOCKED"); // an unpriced product still blocks the quotation
    const o = ownedWork({ lines: [], budgetLines: [mat, slat].map((b) => ({ label: b.label, status: b.status, reason: b.reason })), charges: [], blankExclusionCount: 0, blankPriceReasonCount: 0 });
    expect(o.estimator).toEqual([`Estimator pricing needed: ${mat.label}`, `Estimator pricing needed: ${slat.label}`]);
    expect(o.estimator.join()).not.toMatch(/product choice/);
  });
  it("only a missing or unconfirmed product is a product choice; pricing statuses are the costing subset", () => {
    for (const s of ["not_in_price_source", "supplier_quote_required", "package_incomplete"]) expect(ESTIMATOR_PRICING_STATUSES.has(s) && ESTIMATOR_LINE_STATUSES.has(s)).toBe(true);
    for (const s of ["unmapped", "package_unconfirmed"]) expect(ESTIMATOR_PRICING_STATUSES.has(s)).toBe(false);
    expect(ownedWork({ lines: [], budgetLines: [{ label: "Door", status: "unmapped", reason: "x" }], charges: [], blankExclusionCount: 0, blankPriceReasonCount: 0 }).estimator).toEqual(["Estimator product choice needed: Door"]);
  });
  it("a zero or missing supplier price is still never quoted: the line is unpriced and the total excludes it", () => {
    const g = { ...ctx, priceSource: withGaps({ NQ1161: "zero" }) };
    expect(line(none(), "concrete_slat", g).revenueExTax).toBeNull();
  });
});

describe("default-resolved mappings get the same catalogue checks as explicit ones (applied at sign-off)", () => {
  const inQuote = ["bulk_tank", "feeder", "concrete_slat", "feed_saver_mat", "pvc_door", "led_light", "cup_drinker"];
  it("effectiveMappings adds the defaults for in-quote items, keeps explicit choices, and never invents door/LED/package mappings", () => {
    const m = effectiveMappings({ pvc_door: "NQ2114" }, "STANDARD", inQuote);
    expect(Object.fromEntries(m.map((x) => [x.itemKey, x.sku]))).toEqual({ pvc_door: "NQ2114", ...DEFAULTS });
  });
  it("an explicit entry wins over the default, and the WINDOW variant selects its product", () => {
    expect(effectiveMappings({ feeder: "PNQ082" }, "WINDOW", ["feeder"])).toEqual([{ itemKey: "feeder", sku: "PNQ082" }]);
    expect(effectiveMappings({}, "WINDOW", ["feeder"])).toEqual([{ itemKey: "feeder", sku: "PNQ082-WINDOW" }]);
    expect(effectiveMappings(undefined, "STANDARD", [])).toEqual([]);
  });
  it("an inactive or missing catalogue SKU is refused for a default-resolved mapping", () => {
    const m = effectiveMappings({}, "STANDARD", ["bulk_tank", "feeder"]);
    const cat = (over: Array<{ sku: string; active: boolean | null }>) => over;
    expect(mappingError(m, cat([{ sku: "SYSH-2750-3", active: true }, { sku: "PNQ082", active: true }]), "STANDARD")).toBeNull();
    expect(mappingError(m, cat([{ sku: "SYSH-2750-3", active: false }, { sku: "PNQ082", active: true }]), "STANDARD")).toMatch(/inactive in Cin7/);
    expect(mappingError(m, cat([{ sku: "SYSH-2750-3", active: true }]), "STANDARD")).toMatch(/not in the synced Cin7 catalogue/);
  });
});

describe("normal and demonstration quotations agree on catalogue mappings", () => {
  it("the demonstration seed holds the same products the catalogue resolves by default, so no demonstration exemption is involved", () => {
    for (const [k, sku] of Object.entries(DEFAULTS)) expect(DEMO_DEFAULTS.estimator.confirmedMappings[k as keyof typeof DEFAULTS]).toBe(sku);
    const demo = structuredClone(readyDraft()); const normal = none();
    for (const k of Object.keys(DEFAULTS)) expect(line(normal, k)).toMatchObject({ sku: line(demo, k).sku, unitPrice: line(demo, k).unitPrice });
  });
});
