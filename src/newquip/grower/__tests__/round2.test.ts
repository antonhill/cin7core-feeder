import { describe, expect, it } from "vitest";
import { calculateGrowerHouse } from "../calculate";
import { TOPIGS_GROWER_INPUT, TOPIGS_LIGHT_OVERRIDE } from "../fixture";
import { CCM_FEEDER_CAPACITY_PIGS, GROWER_RULES, LIGHTING_MIN_M2_PER_LIGHT, PIGS_PER_DRINKER } from "../rules";
import { buildBudgetQuote, type ProductCommercials } from "../quote-bridge";
import { resolveMapping } from "../mapping";
import { commercialMappingFor, manualSelectionSkusFor, packageFor } from "../commercial";
import { CURRENT_PRICE_SOURCE, PROJECT_PRICING_NOTICE } from "../pricing-source";
import { ROUND3_OPEN_ITEMS, ROOMS_HELP, VENTILATION_SCOPE_STATUS } from "../round3";
import { valueKindOf } from "../bom-view";
import type { GrowerConfigurationInput } from "../types";

const base = (o: Partial<GrowerConfigurationInput> = {}): GrowerConfigurationInput => ({ ...structuredClone(TOPIGS_GROWER_INPUT), ...o });
const line = (r: ReturnType<typeof calculateGrowerHouse>, k: string) => r.lines.find((l) => l.itemKey === k)!;
const prod = (sku: string, cost: number | null, price: number): ProductCommercials => ({ sku, name: sku, active: true, averageCost: cost, tierPrices: { Tier1: price } });
const opts = { tierCode: "Tier1", taxRatePct: 15, taxInclusive: false };
const cat = new Set(["F"]);
const mapped = (m: Record<string, string>) => new Map(Object.entries(m).map(([k, sku]) => [k, resolveMapping(k as never, [], sku, cat)]));

describe("ROOMS — an actual room within a building", () => {
  it("the help text states the confirmed meaning (6 buildings × 2 rooms = 12)", () => {
    expect(ROOMS_HELP).toMatch(/actual room within a building/);
    expect(ROOMS_HELP).toMatch(/6 buildings × 2 rooms = 12/);
  });
  it("every per-room quantity is multiplied by the NUMBER OF ROOMS", () => {
    for (const rooms of [1, 2, 12]) {
      const r = calculateGrowerHouse(base({ rooms, quantityOverrides: { feeder: 18, concrete_slat: 700 } }));
      expect(line(r, "feeder").projectQuantity).toBe(18 * rooms);
      expect(line(r, "concrete_slat").projectQuantity).toBe(700 * rooms);
      expect(line(r, "led_light").projectQuantity).toBe(29 * rooms);
      expect(r.derived.rooms).toBe(rooms);
    }
  });
  it("the room count is the multiplier, not a count of buildings: 6 buildings × 2 rooms is entered as 12", () => {
    const r = calculateGrowerHouse(base({ rooms: 6 * 2 }));
    expect(line(r, "led_light").projectQuantity).toBe(29 * 12);
  });
  it("the engine's input and fields speak of rooms, never buildings", () => {
    expect(Object.keys(TOPIGS_GROWER_INPUT).some((k) => /building/i.test(k))).toBe(false);
  });
});

describe("FEEDER — capacity confirmed, quantity NOT automated", () => {
  const r = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
  it("CCM capacity is 45 pigs and is shown", () => {
    expect(CCM_FEEDER_CAPACITY_PIGS).toBe(45);
    expect(line(r, "feeder").hypothesis?.expression).toContain("45 pigs per feeder");
  });
  it("no feeder quantity is produced — not ceil(pigs/45), not pens − hospital", () => {
    const f = line(r, "feeder");
    expect(f.basis).toBe("awaiting_validation");
    expect(f.quantityPerRoom).toBeNull();
    expect(f.hypothesis?.value).toBeNull();
    expect(valueKindOf(f)).toBe("estimator_input_required");
  });
  it("an estimator-entered quantity is accepted and marked as an override needing a reason", () => {
    const f = line(calculateGrowerHouse(base({ quantityOverrides: { feeder: 18 } })), "feeder");
    expect(f).toMatchObject({ basis: "manual_override", quantityPerRoom: 18, overrideReason: null });
    const withReason = line(calculateGrowerHouse(base({ quantityOverrides: { feeder: 18 }, quantityOverrideReasons: { feeder: "per pen layout" } })), "feeder");
    expect(withReason.overrideReason).toBe("per pen layout");
  });
  it("PNQ082 remains the sourced feeder recommendation (not confirmed by the app)", () => {
    expect(commercialMappingFor("feeder")).toMatchObject({ kind: "single", recommendedSku: "PNQ082" });
  });
});

describe("DRINKER — 15 pigs per drinker is the basis; the quantity is only SUGGESTED", () => {
  it("shows an unrounded suggestion and produces no quantity", () => {
    expect(PIGS_PER_DRINKER).toBe(15);
    const d = line(calculateGrowerHouse(TOPIGS_GROWER_INPUT), "cup_drinker");
    expect(d.basis).toBe("awaiting_validation");
    expect(d.quantityPerRoom).toBeNull();
    expect(d.hypothesis?.value).toBe(40);
    const odd = line(calculateGrowerHouse(base({ pigsPerRoom: 610 })), "cup_drinker");
    expect(odd.hypothesis?.value).toBe(40.67); // NOT rounded to a whole drinker
  });
  it("the Master's NB3542-03 is recorded as an alternative identity but is never priced automatically", () => {
    const pkg = packageFor("cup_drinker")!;
    expect(pkg.alternativeIdentity?.sku).toBe("NB3542-03");
    expect(pkg.components.some((c) => c.sku === "NB3542-03")).toBe(false);
  });
});

describe("SLATS — slatted floor area is an estimator input", () => {
  it("there is no universal walkway/footprint-derived quantity", () => {
    const r = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
    expect(line(r, "concrete_slat").basis).toBe("awaiting_validation");
    expect(line(r, "concrete_slat").quantityPerRoom).toBeNull();
    expect(GROWER_RULES.find((x) => x.itemKey === "concrete_slat")!.sourceInputs).toEqual(["slattedFloorAreaM2", "selectedFlooringType"]);
  });
  it("the area is a validated input and the final quantity is estimator-entered", () => {
    expect(calculateGrowerHouse(base({ slattedFloorAreaM2: -5 })).valid).toBe(false);
    const r = calculateGrowerHouse(base({ slattedFloorAreaM2: 700, quantityOverrides: { concrete_slat: 1300 } }));
    expect(line(r, "concrete_slat")).toMatchObject({ basis: "manual_override", quantityPerRoom: 1300, projectQuantity: 1300 * 12 });
  });
});

describe("LIGHTING — minimum 1 per 25 m² + a VISIBLE override", () => {
  it("defaults to the rounded-up minimum, labelled DEFAULT", () => {
    expect(LIGHTING_MIN_M2_PER_LIGHT).toBe(25);
    const l = line(calculateGrowerHouse(TOPIGS_GROWER_INPUT), "led_light");
    expect(l).toMatchObject({ basis: "system_default", quantityPerRoom: 29, defaultQuantityPerRoom: 29, overrideState: "none" });
    expect(valueKindOf(l)).toBe("default_suggested");
    expect(line(calculateGrowerHouse(base({ lengthM: 10, widthM: 5 })), "led_light").quantityPerRoom).toBe(2); // 50 m² → 2
    expect(line(calculateGrowerHouse(base({ lengthM: 5, widthM: 5 })), "led_light").quantityPerRoom).toBe(1); // exactly 25 m² → 1
  });
  it("Topigs' 38 is a customer override: visible, reasoned, and the default is retained", () => {
    const l = line(calculateGrowerHouse(base({ ...TOPIGS_LIGHT_OVERRIDE })), "led_light");
    expect(l).toMatchObject({ basis: "manual_override", overrideState: "manual_override", quantityPerRoom: 38, defaultQuantityPerRoom: 29 });
    expect(l.overrideReason).toMatch(/Customer-specific/);
    expect(valueKindOf(l)).toBe("estimator_input");
    expect(l.explanation.steps.join("\n")).toContain("System default retained: 29");
  });
  it("an override with no reason is flagged on the budget, not defaulted", () => {
    const calc = calculateGrowerHouse(base({ quantityOverrides: { led_light: 38 } }));
    const b = buildBudgetQuote(calc.lines, new Map(), new Map(), opts);
    expect(b.blockers).toContain("FORTIS 1.2 5000K LED light (incl. clips & cable): override reason required");
  });
});

describe("FORTIS — never silently FERAX", () => {
  it("shows SKU REQUIRED / UNMAPPED and keeps HNQ7046 as a surrogate only", () => {
    const lum = packageFor("led_light")!.components.find((c) => c.id === "luminaire")!;
    expect(lum.skuRequired).toBe("FORTIS 1.2 — SKU REQUIRED / UNMAPPED");
    expect(lum.sku).toBeNull();
    expect(lum.historicSurrogate?.sku).toBe("HNQ7046");
    expect(lum.description).not.toMatch(/FERAX/);
  });
  it("a priced HNQ7046 in the catalogue does NOT price the FORTIS package", () => {
    const calc = calculateGrowerHouse(base());
    const b = buildBudgetQuote(calc.lines, new Map(), new Map([["HNQ7046", prod("HNQ7046", 484, 900)]]), { ...opts, confirmedPackages: new Set(["led_light"]) });
    const l = b.lines.find((x) => x.itemKey === "led_light")!;
    expect(l.status).toBe("package_incomplete");
    expect(l.revenueExTax).toBeNull();
  });
});

describe("M75 — Master SKUs and the preserved distinctions", () => {
  const pkg = packageFor("flex_auger")!;
  const sku = (id: string) => pkg.components.find((c) => c.id === id)!.sku;
  it("maps the confirmed Master SKUs", () => {
    expect(sku("tube")).toBe("NQ1223");
    expect(sku("elbow")).toBe("NQ1227");
    expect(sku("clamps")).toBe("NQ1764");
    expect(sku("dropkit")).toBe("NQ1942");
    expect(sku("droptube")).toBe("NQ.TUBE.75");
  });
  it("the M75 auger tube, the clear drop tube and NQ.TUBE.63 are three different things", () => {
    expect(new Set([sku("tube"), sku("droptube"), "NQ.TUBE.63"]).size).toBe(3);
    expect(pkg.components.some((c) => c.sku === "NQ.TUBE.63")).toBe(false);
  });
  it("the flex quantity stays an estimator entry: the hidden W/W1 (K–O) formulas are NOT ported", () => {
    const rule = GROWER_RULES.find((r) => r.itemKey === "flex_auger")!;
    expect(rule.classification).toBe("requires_validation");
    expect(rule.verifiedCompute).toBeUndefined();
    expect(rule.seanQuestion).toMatch(/hidden columns K–O/);
    expect(line(calculateGrowerHouse(TOPIGS_GROWER_INPUT), "flex_auger").quantityPerRoom).toBeNull();
  });
});

describe("NQ3132 — replacement drive unit with a pricing exception", () => {
  const drive = packageFor("flex_auger")!.components.find((c) => c.id === "drive")!;
  const calc = calculateGrowerHouse(base({ quantityOverrides: { flex_auger: 1 }, quantityOverrideReasons: { flex_auger: "Topigs reference" } }));
  it("replaces TRA1.1KW3PH", () => {
    expect(drive.sku).toBe("NQ3132");
    expect(JSON.stringify(packageFor("flex_auger"))).not.toMatch(/"sku":"TRA1\.1KW3PH"/);
  });
  it.each([0, 100])("is never priced automatically, whatever the catalogue price (%i)", (price) => {
    const products = new Map([["NQ3132", prod("NQ3132", 50, price)]]);
    const b = buildBudgetQuote(calc.lines, new Map(), products, { ...opts, confirmedPackages: new Set(["flex_auger"]) });
    const c = b.lines.find((l) => l.itemKey === "flex_auger")!.components!.find((x) => x.id === "drive")!;
    expect(c.status).toBe("pricing_exception");
    expect(c.reason).toMatch(/PRICING EXCEPTION — ESTIMATOR REVIEW REQUIRED/);
    expect(c.unitPrice).toBeNull();
    expect(c.revenueExTax).toBeNull();
    expect(b.totals.subtotalExTax).toBe(0);
  });
});

describe("PENNING — running metres, never m²", () => {
  it("is in running metres per room, needs a pig size, and has no automatic price", () => {
    const none = line(calculateGrowerHouse(base()), "penning_package");
    expect(none).toMatchObject({ unit: "running_metre", basis: "awaiting_validation", quantityPerRoom: null });
    expect(none.inputRequired).toMatch(/pig size and enter the running metres/);
    expect(line(calculateGrowerHouse(base({ penningPigSize: "MEDIUM" })), "penning_package").inputRequired).toBe("Enter the running metres for one room.");
    expect(line(calculateGrowerHouse(base({ penningRunningMetresPerRoom: 200 })), "penning_package").inputRequired).toBe("Select the pig size.");
    const ok = line(calculateGrowerHouse(base({ penningPigSize: "LARGE", penningRunningMetresPerRoom: 244.87 })), "penning_package");
    expect(ok).toMatchObject({ basis: "estimator_input", quantityPerRoom: 244.87 });
    expect(ok.projectQuantity).toBeCloseTo(244.87 * 12, 6);
    expect(valueKindOf(ok)).toBe("estimator_input");
  });
  it("rejects a bad pig size and negative metres", () => {
    expect(calculateGrowerHouse(base({ penningPigSize: "HUGE" as never })).valid).toBe(false);
    expect(calculateGrowerHouse(base({ penningRunningMetresPerRoom: -1 })).valid).toBe(false);
  });
  it("even with metres + size entered, pricing is ESTIMATOR PRICING REQUIRED — no rate is invented", () => {
    const calc = calculateGrowerHouse(base({ penningPigSize: "SMALL", penningRunningMetresPerRoom: 100 }));
    const b = buildBudgetQuote(calc.lines, mapped({ penning_package: "F" }), new Map([["F", prod("F", 10, 99)]]), opts);
    const l = b.lines.find((x) => x.itemKey === "penning_package")!;
    expect(l.status).toBe("estimator_pricing_required");
    expect(l.revenueExTax).toBeNull();
    expect(b.blockers.some((x) => /ESTIMATOR PRICING REQUIRED \(per running metre/.test(x))).toBe(true);
  });
});

describe("PVC DOORS — manual selection", () => {
  it("has no sizing formula; the estimator picks from the Round 1 candidates by description", () => {
    const rule = GROWER_RULES.find((r) => r.itemKey === "pvc_door")!;
    expect(rule.mode).toBe("manual");
    expect(rule.verifiedCompute).toBeUndefined();
    expect(rule.defaultCompute).toBeUndefined();
    expect(manualSelectionSkusFor("pvc_door")).toEqual(["NQ2114", "NQ2113", "NQ2112", "NQ2161", "NQ2281"]);
    expect(commercialMappingFor("pvc_door")?.kind).toBe("unresolved");
    // a candidate is never auto-confirmed
    expect(resolveMapping("pvc_door", [{ sku: "NQ2114", name: "x" }], null).status).toBe("AMBIGUOUS");
  });
});

describe("DELIVERY / INSTALLATION — explicit estimator-entered amounts", () => {
  const calc = calculateGrowerHouse(base({ quantityOverrides: { feeder: 18 }, quantityOverrideReasons: { feeder: "r" } }));
  const run = (estimatorCharges: Record<string, number | null>) => buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), new Map([["F", prod("F", 100, 200)]]), { ...opts, estimatorCharges });
  it("are required, never zero, and flagged until entered", () => {
    const b = run({});
    expect(b.charges.map((c) => [c.key, c.status])).toEqual([["delivery", "required"], ["installation", "required"]]);
    expect(b.blockers).toEqual(expect.arrayContaining(["Delivery: estimator-entered amount required", "Installation: estimator-entered amount required"]));
    expect(run({ delivery: 0 }).charges[0].status).toBe("required"); // 0 is not an entry
  });
  it("entered amounts become uncosted lines (they never touch the margin) and add to the totals", () => {
    const without = run({});
    const b = run({ delivery: 10000, installation: 5000 });
    expect(b.totals.subtotalExTax - without.totals.subtotalExTax).toBe(15000);
    expect(b.totals.estimatedCost).toBe(without.totals.estimatedCost);
    expect(b.blockers.some((x) => /Delivery|Installation/.test(x))).toBe(false);
  });
});

describe("PROJECT pricing — safely unresolved", () => {
  const calc = calculateGrowerHouse(base({ quantityOverrides: { feeder: 18 }, quantityOverrideReasons: { feeder: "r" } }));
  const products = new Map([["F", prod("F", 100, 200)]]);
  it("applies NO formula: no line is priced, nothing is cost × 1.2", () => {
    const b = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), products, { ...opts, quoteType: "project" });
    expect(b.quoteType).toBe("project");
    expect(b.pricingNotice).toBe(PROJECT_PRICING_NOTICE);
    expect(b.pricingNotice).toMatch(/ESTIMATOR PRICING REQUIRED/);
    expect(b.lines.filter((l) => l.status !== "not_selected").every((l) => l.revenueExTax === null)).toBe(true);
    expect(b.totals.subtotalExTax).toBe(0);
    expect(b.state).toBe("awaiting_pricing");
    expect(b.blockers).toContain("Project selling price: ESTIMATOR PRICING REQUIRED (no automatic project price exists)");
  });
  it("only an estimator-entered selling price produces a total, shown as such", () => {
    const b = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), products, { ...opts, quoteType: "project", projectSellingPriceExTax: 500000 });
    expect(b.totals.subtotalExTax).toBe(500000);
    expect(b.pricingNotice).toBeTruthy();
  });
  it("day-to-day uses the tier price and has no project notice", () => {
    const b = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), products, opts);
    expect(b.quoteType).toBe("day_to_day");
    expect(b.pricingNotice).toBeNull();
    expect(b.totals.subtotalExTax).toBe(200 * 18 * 12);
  });
});

describe("PRICE SOURCE — explicit and swappable", () => {
  it("names the interim source and says the production source is unresolved", () => {
    expect(CURRENT_PRICE_SOURCE).toMatchObject({ id: "cin7_synced_price_tiers", provisional: true });
    expect(CURRENT_PRICE_SOURCE.notice).toMatch(/UNRESOLVED/);
  });
  it("the budget carries the source it used, and accepts another without engine changes", () => {
    const calc = calculateGrowerHouse(base());
    expect(buildBudgetQuote(calc.lines, new Map(), new Map(), opts).priceSource).toBe(CURRENT_PRICE_SOURCE);
    const other = { ...CURRENT_PRICE_SOURCE, id: "newquip_master_excel" as const, label: "NewQuip Master (test)" };
    expect(buildBudgetQuote(calc.lines, new Map(), new Map(), { ...opts, priceSource: other }).priceSource.id).toBe("newquip_master_excel");
  });
});

describe("REP VISIBILITY — cost is withheld, not just hidden", () => {
  const calc = calculateGrowerHouse(base({ quantityOverrides: { feeder: 18 }, quantityOverrideReasons: { feeder: "r" } }));
  it("with withholdCost a missing cost is not a blocker and no cost / GP / margin is reported", () => {
    const b = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), new Map([["F", prod("F", null, 200)]]), { ...opts, withholdCost: true, estimatorCharges: { delivery: 1, installation: 1 } });
    expect(b.blockers.some((x) => /Average Cost/.test(x))).toBe(false);
    expect(b.lines.find((l) => l.itemKey === "feeder")!.status).toBe("priced");
    expect(b.totals).toMatchObject({ estimatedCost: 0, estimatedGP: 0, overallMarginPct: null });
  });
  it("without withholdCost (an estimator/admin) a missing cost still blocks the margin", () => {
    const b = buildBudgetQuote(calc.lines, mapped({ feeder: "F" }), new Map([["F", prod("F", null, 200)]]), opts);
    expect(b.blockers.some((x) => /Average Cost/.test(x))).toBe(true);
  });
});

describe("VENTILATION and ROUND 3", () => {
  it("ventilation / cooling scope is PENDING REFERENCE QUOTE VALIDATION and no fan rule is invented", () => {
    expect(VENTILATION_SCOPE_STATUS).toBe("PENDING REFERENCE QUOTE VALIDATION");
    for (const k of ["pad_cooling", "cone_fans"] as const) {
      const rule = GROWER_RULES.find((r) => r.itemKey === k)!;
      expect(rule.classification).toBe("manual");
      expect(rule.evidence).toMatch(/PENDING REFERENCE QUOTE VALIDATION/);
      expect(rule.verifiedCompute).toBeUndefined();
      expect(rule.defaultCompute).toBeUndefined();
    }
  });
  it("all ten Round 3 items are present, correctly prioritised, and still OPEN", () => {
    expect(ROUND3_OPEN_ITEMS).toHaveLength(10);
    expect(ROUND3_OPEN_ITEMS.every((i) => i.status === "OPEN")).toBe(true);
    const by = (p: string) => ROUND3_OPEN_ITEMS.filter((i) => i.priority === p).map((i) => i.topic);
    expect(by("BLOCKER")).toEqual(["Project pricing", "Price source of truth"]);
    expect(by("HIGH")).toHaveLength(5);
    expect(by("MEDIUM")).toHaveLength(3);
    expect(ROUND3_OPEN_ITEMS.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe("the three value kinds", () => {
  it("maps every basis to exactly one visible kind", () => {
    expect(valueKindOf({ basis: "system_calculated" })).toBe("auto_calculated");
    expect(valueKindOf({ basis: "system_default" })).toBe("default_suggested");
    expect(valueKindOf({ basis: "manual_override" })).toBe("estimator_input");
    expect(valueKindOf({ basis: "estimator_input" })).toBe("estimator_input");
    expect(valueKindOf({ basis: "awaiting_validation" })).toBe("estimator_input_required");
  });
});

describe("GOLDEN Topigs validation with Round 2 applied", () => {
  const r = calculateGrowerHouse(base({ ...TOPIGS_LIGHT_OVERRIDE }));
  it("floor area and rooms are unchanged", () => {
    expect(r.derived.floorAreaM2).toBeCloseTo(714.285, 6);
    expect(r.derived.rooms).toBe(12);
  });
  it("the historic Topigs figures remain REFERENCE ONLY — only the lighting override carries a quantity", () => {
    const withQty = r.lines.filter((l) => l.projectQuantity != null && l.basis !== "not_selected");
    expect(withQty.map((l) => l.itemKey)).toEqual(["led_light"]);
    expect(line(r, "led_light").projectQuantity).toBe(38 * 12);
  });
});
