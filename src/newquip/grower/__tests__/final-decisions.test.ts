import { describe, expect, it } from "vitest";
import { calculateGrowerHouse } from "../calculate";
import { evaluateDraft } from "../evaluate";
import { createWorkbookPriceSource, landedCostCents, projectPriceCents, PENNING_RATE_PER_RM, type PriceSnapshot } from "../workbook-price-source";
import { FINAL_GROWER_DECISIONS } from "../final-feedback";
import { CCM_FEEDER_CAPACITY_PIGS, GROWER_RULES, PIGS_PER_DRINKER } from "../rules";
import { TOPIGS_GROWER_INPUT } from "../fixture";
import { feederSkuFor } from "../commercial";
import type { GrowerConfigurationInput } from "../types";
import { TEST_SNAPSHOT, testPriceSource } from "./test-snapshot";
import { readyDraft } from "./golden";

const base = (o: Partial<GrowerConfigurationInput> = {}): GrowerConfigurationInput => ({ ...structuredClone(TOPIGS_GROWER_INPUT), ...o });
const line = (r: ReturnType<typeof calculateGrowerHouse>, k: string) => r.lines.find((l) => l.itemKey === k)!;
const ctx = { priceSource: testPriceSource(), withholdCost: false };

describe("ROOMS — pigsPerRoom (the ±600 is per room)", () => {
  it("the input is pigsPerRoom, not per building", () => {
    expect(TOPIGS_GROWER_INPUT).toHaveProperty("pigsPerRoom", 600);
    expect(Object.keys(TOPIGS_GROWER_INPUT).some((k) => /perBuilding|pigsPerBuilding/i.test(k))).toBe(false);
  });
  it("every per-room quantity multiplies by the actual number of rooms", () => {
    for (const rooms of [1, 2, 12]) {
      const r = calculateGrowerHouse(base({ rooms, estimatorQuantities: { feeder: 14, concrete_slat: 700 } }));
      expect(line(r, "feeder").projectQuantity).toBe(14 * rooms);
      expect(line(r, "concrete_slat").projectQuantity).toBe(700 * rooms);
      expect(line(r, "led_light").projectQuantity).toBe(29 * rooms);
    }
  });
  it("no rule text still calls the room basis provisional", () => {
    expect(JSON.stringify(GROWER_RULES.map((r) => r.evidence))).not.toMatch(/provisional.*per.?room|per.?room.*unresolved/i);
  });
});

describe("LIGHTING — minimum = ceil(room floor area / 25): a confirmed DEFAULT with a visible, reasoned override", () => {
  it("calculates ceil(area / 25) per room", () => {
    for (const [l, w, expected] of [[49.5, 14.43, 29], [10, 10, 4], [10, 2.5, 1], [5, 5.1, 2]] as const) {
      expect(line(calculateGrowerHouse(base({ lengthM: l, widthM: w })), "led_light").quantityPerRoom).toBe(expected);
    }
  });
  it("is classified verified yet labelled a default, and stays overridable", () => {
    const rule = GROWER_RULES.find((r) => r.itemKey === "led_light")!;
    expect(rule.classification).toBe("verified");
    expect(rule.mode).toBe("default");
    expect(rule.overrideAllowed).toBe(true);
    expect(line(calculateGrowerHouse(base()), "led_light").basis).toBe("system_default");
  });
  it("an upward override keeps the calculated minimum visible and carries its reason", () => {
    const l = line(calculateGrowerHouse(base({ quantityOverrides: { led_light: 38 }, quantityOverrideReasons: { led_light: "Farmer asked for more" } })), "led_light");
    expect(l).toMatchObject({ basis: "manual_override", quantityPerRoom: 38, defaultQuantityPerRoom: 29, overrideReason: "Farmer asked for more" });
  });
  it("an override WITHOUT a reason blocks the quote — it is never silently allowed", () => {
    const d = readyDraft({ config: { ...readyDraft().config, quantityOverrides: { led_light: 38 }, quantityOverrideReasons: {} } });
    const ev = evaluateDraft(d, ctx);
    expect(ev.readiness.state).toBe("BLOCKED");
    expect(ev.readiness.reasons.join("\n")).toMatch(/override reason required/);
    expect(ev.readiness.counts.overrides).toBe(1);
  });
});

describe("CCM FEEDER — capacity displayed; the final quantity is the estimator's", () => {
  it("capacity is 45 pigs and is shown; no ceil(pigs/45) is presented as the rule", () => {
    expect(CCM_FEEDER_CAPACITY_PIGS).toBe(45);
    const f = line(calculateGrowerHouse(base()), "feeder");
    expect(f.hypothesis?.expression).toContain("45 pigs per feeder");
    expect(f.quantityPerRoom).toBeNull(); // 600 / 45 = 13.33 → NOT auto-rounded to 14
    expect(f.basis).toBe("awaiting_validation");
  });
  it("an estimator-entered quantity is an ESTIMATOR INPUT — not an override, no reason needed", () => {
    const f = line(calculateGrowerHouse(base({ estimatorQuantities: { feeder: 15 } })), "feeder");
    expect(f).toMatchObject({ basis: "estimator_input", quantityPerRoom: 15, overrideState: "none", overrideReason: null });
  });
  it("standard = PNQ082, window = PNQ082-WINDOW — one feeder, two variants", () => {
    expect(feederSkuFor("STANDARD")).toBe("PNQ082");
    expect(feederSkuFor("WINDOW")).toBe("PNQ082-WINDOW");
    expect(feederSkuFor(undefined)).toBe("PNQ082");
    const std = evaluateDraft(readyDraft(), ctx).budget!.lines.find((l) => l.itemKey === "feeder")!;
    expect(std.sku).toBe("PNQ082");
    const d = readyDraft();
    const win = evaluateDraft({ ...d, config: { ...d.config, feederVariant: "WINDOW" }, estimator: { ...d.estimator, confirmedMappings: { ...d.estimator.confirmedMappings, feeder: "PNQ082-WINDOW" } } }, ctx).budget!.lines.find((l) => l.itemKey === "feeder")!;
    expect(win.sku).toBe("PNQ082-WINDOW");
    expect(win.unitPrice).toBeGreaterThan(std.unitPrice!);
  });
  it("a window variant with the STANDARD sku confirmed does not silently price", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, config: { ...d.config, feederVariant: "WINDOW" } }, ctx);
    expect(ev.budget!.lines.find((l) => l.itemKey === "feeder")!.status).toBe("unmapped");
    expect(ev.readiness.state).toBe("BLOCKED");
  });
});

describe("DRINKERS — 15 pigs per drinker is a SUGGESTION; the estimator confirms", () => {
  it("suggests pigsPerRoom / 15 and keeps it distinct from the authoritative quantity", () => {
    expect(PIGS_PER_DRINKER).toBe(15);
    const before = line(calculateGrowerHouse(base()), "cup_drinker");
    expect(before.suggestedQuantityPerRoom).toBe(40);
    expect(before.quantityPerRoom).toBeNull();
    const after = line(calculateGrowerHouse(base({ estimatorQuantities: { cup_drinker: 54 } })), "cup_drinker");
    expect(after).toMatchObject({ basis: "estimator_input", quantityPerRoom: 54, suggestedQuantityPerRoom: 40 });
  });
  it("the historic 54 is not treated as proof of a formula", () => {
    expect(GROWER_RULES.find((r) => r.itemKey === "cup_drinker")!.evidence).toMatch(/does not prove a formula/);
  });
});

describe("SLATS — manual by design", () => {
  it("never derived from area: the area is context only", () => {
    const a = line(calculateGrowerHouse(base({ slattedFloorAreaM2: 500 })), "concrete_slat");
    const b = line(calculateGrowerHouse(base({ slattedFloorAreaM2: 5000 })), "concrete_slat");
    expect(a.quantityPerRoom).toBeNull();
    expect(b.quantityPerRoom).toBeNull();
    expect(a.hypothesis).toBeNull();
  });
  it("is an ESTIMATOR INPUT by design with no Round 3 blocker language", () => {
    const rule = GROWER_RULES.find((r) => r.itemKey === "concrete_slat")!;
    expect(rule.treatment).toBe("estimator_input");
    expect(JSON.stringify(rule)).not.toMatch(/round 3|blocker/i);
    expect(line(calculateGrowerHouse(base({ estimatorQuantities: { concrete_slat: 700 } })), "concrete_slat").basis).toBe("estimator_input");
  });
});

describe("PENNING — running metres × Sean's confirmed rate by pig size", () => {
  it("rates: small R1,300 · medium R1,500 · large R2,200 per running metre", () => {
    expect(PENNING_RATE_PER_RM).toEqual({ SMALL: 1300, MEDIUM: 1500, LARGE: 2200 });
    expect(FINAL_GROWER_DECISIONS.penning.rateExVatByPigSize).toEqual({ SMALL: 1300, MEDIUM: 1500, LARGE: 2200 });
  });
  for (const [size, rate] of [["SMALL", 1300], ["MEDIUM", 1500], ["LARGE", 2200]] as const) {
    it(`${size}: project running metres × R${rate} — no SKU needed`, () => {
      const d = readyDraft();
      const ev = evaluateDraft({ ...d, config: { ...d.config, penningPigSize: size, penningRunningMetresPerRoom: 10, rooms: 3 } }, ctx);
      const pen = ev.budget!.lines.find((l) => l.itemKey === "penning_package")!;
      expect(pen).toMatchObject({ status: "priced", sku: null, quantity: 30, unitPrice: rate, revenueExTax: 30 * rate, pricedBy: "penning_rate" });
      expect(pen.reason).toMatch(/pig-size \/ running-metre basis/);
    });
  }
  it("without a pig size the line is not priced (and not zero)", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, config: { ...d.config, penningPigSize: null } }, ctx);
    expect(ev.budget!.lines.find((l) => l.itemKey === "penning_package")!.status).toBe("no_quantity");
  });
});

describe("M75 — estimator input by design (no W/W1 port)", () => {
  it("quantity and price are the estimator's; the historic package is reference only", () => {
    const ev = evaluateDraft(readyDraft(), ctx);
    const m75 = ev.budget!.lines.find((l) => l.itemKey === "flex_auger")!;
    expect(m75).toMatchObject({ status: "priced", pricedBy: "estimator_input", unitPrice: 150_000, quantity: 12 });
    expect(m75.components!.every((c) => c.status !== "priced")).toBe(true);
    expect(GROWER_RULES.find((r) => r.itemKey === "flex_auger")!.treatment).toBe("estimator_input");
  });
  it("without the estimator's commercial price the quote is BLOCKED — a manual item is a defect only while unsupplied", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, estimator: { ...d.estimator, unitPrices: {} } }, ctx);
    expect(ev.readiness.state).toBe("BLOCKED");
    expect(ev.budget!.lines.find((l) => l.itemKey === "flex_auger")!.status).toBe("estimator_price_required");
  });
  it("NQ3132 is N/A / supplier-quote-required inside M75 and never priced at zero", () => {
    const m75 = evaluateDraft(readyDraft(), ctx).budget!.lines.find((l) => l.itemKey === "flex_auger")!;
    const drive = m75.components!.find((c) => c.sku === "NQ3132")!;
    expect(drive.status).toBe("supplier_quote_required");
    expect(drive.unitPrice).toBeNull();
    expect(drive.reason).toMatch(/supplier quote required/i);
  });
});

describe("VENTILATION — optional inside Grower, engineering review", () => {
  it("every ventilation item is optional, off by default, and estimator-entered once selected", () => {
    const optional = GROWER_RULES.filter((r) => r.optionalKey);
    expect(optional.length).toBe(7);
    for (const r of optional) expect(r.treatment).toBe("engineering_review");
    const off = calculateGrowerHouse(base()).lines.filter((l) => l.basis === "not_selected");
    expect(off.length).toBe(7);
    const on = calculateGrowerHouse(base({ optionalEquipment: { ...TOPIGS_GROWER_INPUT.optionalEquipment, cone_fans: true } }));
    expect(line(on, "cone_fans").basis).toBe("awaiting_validation");
    const entered = calculateGrowerHouse(base({ optionalEquipment: { ...TOPIGS_GROWER_INPUT.optionalEquipment, cone_fans: true }, estimatorQuantities: { cone_fans: 6 } }));
    expect(line(entered, "cone_fans")).toMatchObject({ basis: "estimator_input", quantityPerRoom: 6 });
  });
  it("no fan quantity or controller rule is invented", () => {
    for (const k of ["cone_fans", "controller", "pad_cooling"] as const) {
      expect(GROWER_RULES.find((r) => r.itemKey === k)!.verifiedCompute).toBeUndefined();
      expect(GROWER_RULES.find((r) => r.itemKey === k)!.defaultCompute).toBeUndefined();
    }
  });
});

describe("EXCLUSIONS — required by default, excluded only with a visible reason", () => {
  it("a customer-driven exclusion removes the line and is reported", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, config: { ...d.config, exclusions: { pvc_door: "Customer supplies own doors" } } }, ctx);
    expect(ev.calc.lines.find((l) => l.itemKey === "pvc_door")).toMatchObject({ basis: "not_selected", projectQuantity: 0, exclusionReason: "Customer supplies own doors" });
    expect(ev.readiness.items.warnings.map((w) => w.detail).join("\n")).toMatch(/Excluded at the customer's request/);
    expect(ev.readiness.state).toBe("READY");
  });
  it("an exclusion without a reason is not honoured", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, config: { ...d.config, exclusions: { pvc_door: "   " } } }, ctx);
    expect(ev.calc.lines.find((l) => l.itemKey === "pvc_door")!.basis).toBe("estimator_input");
  });
});

describe("POC PRICE SOURCE — the NewQuip Master workbook snapshot", () => {
  const src = testPriceSource();
  it("is named and carries provenance", () => {
    expect(src.descriptor.label).toBe("NewQuip Master workbook – POC controlled snapshot");
    expect(src.descriptor.provenance).toContain("2026-10-05");
    expect(src.descriptor.notice).toMatch(/Cin7 holds demo data/);
    const ev = evaluateDraft(readyDraft(), ctx);
    expect(ev.budget!.priceSource.label).toBe("NewQuip Master workbook – POC controlled snapshot");
  });
  it("day-to-day uses the workbook Retail Price ex VAT", () => {
    expect(src.priceFor("PNQ082", "day_to_day")).toMatchObject({ status: "priced", unitPriceExVat: 1680 });
  });
  it("is swappable: the engine only knows the PriceSource interface", () => {
    const other = createWorkbookPriceSource({ ...TEST_SNAPSHOT, entries: { PNQ082: { ...TEST_SNAPSHOT.entries.PNQ082, retailExVat: 2000 } } } as PriceSnapshot);
    expect(other.priceFor("PNQ082", "day_to_day")).toMatchObject({ unitPriceExVat: 2000 });
  });
  it("a SKU absent from the snapshot is not_in_source — never a guessed or zero price", () => {
    expect(src.priceFor("NOPE", "project").status).toBe("not_in_source");
  });
});

describe("PROJECT PRICING — landed cost + 20%, NOT retail MU + another 20%", () => {
  const src = testPriceSource();
  it("landed cost = Cost × ROE × Freight", () => {
    expect(landedCostCents({ cost: 1000, roe: 1, freight: 1.2 })).toBe(120_000);
    expect(landedCostCents({ cost: 33, roe: 19.08, freight: 1.2 })).toBe(75557); // 755.568 → 755.57
  });
  it("project selling price = landed cost × 1.20", () => {
    expect(projectPriceCents(120_000)).toBe(144_000);
    expect(src.priceFor("PNQ082", "project")).toEqual({ status: "priced", unitPriceExVat: 1440, landedCostExVat: 1200 });
  });
  it("the workbook MU is NOT applied for projects (retail 1,680 → project 1,440, not 1,680 × 1.2)", () => {
    const retail = (src.priceFor("PNQ082", "day_to_day") as { unitPriceExVat: number }).unitPriceExVat;
    const project = (src.priceFor("PNQ082", "project") as { unitPriceExVat: number }).unitPriceExVat;
    expect(project).toBe(1440);
    expect(project).not.toBe(retail * 1.2);
    expect(project).toBeLessThan(retail);
  });
  it("is computed in integer cents (no floating-point drift)", () => {
    expect(projectPriceCents(1)).toBe(1); // 1.2 → 1
    expect(projectPriceCents(7)).toBe(8); // 8.4 → 8
    expect(projectPriceCents(75557)).toBe(90668); // 90668.4 → 90668
  });
  it("a project quote prices every source line from landed + 20%; a day-to-day quote from retail", () => {
    const project = evaluateDraft(readyDraft({ quoteType: "project" }), ctx).budget!;
    const day = evaluateDraft(readyDraft({ quoteType: "day_to_day" }), ctx).budget!;
    expect(project.lines.find((l) => l.itemKey === "feeder")!.unitPrice).toBe(1440);
    expect(day.lines.find((l) => l.itemKey === "feeder")!.unitPrice).toBe(1680);
    expect(project.pricingBasis).toMatch(/landed cost.*\+ 20%/i);
    expect(day.pricingBasis).toMatch(/Retail Price ex VAT/);
  });
});

describe("ZERO PRICE — supplier quote required, never R0", () => {
  const src = testPriceSource();
  it("NQ3132 (Retail 0) is supplier_quote_required for both quote types", () => {
    for (const t of ["day_to_day", "project"] as const) {
      const r = src.priceFor("NQ3132", t);
      expect(r.status).toBe("supplier_quote_required");
      expect(JSON.stringify(r)).not.toMatch(/unitPrice/);
    }
  });
  it("a required single-SKU line with a zero price blocks the quote (and adds NO zero revenue)", () => {
    const snap: PriceSnapshot = { ...TEST_SNAPSHOT, entries: { ...TEST_SNAPSHOT.entries, NQ1161: { ...TEST_SNAPSHOT.entries.NQ1161, cost: 0, retailExVat: 0 } } };
    const ev = evaluateDraft(readyDraft(), { priceSource: createWorkbookPriceSource(snap), withholdCost: false });
    const slat = ev.budget!.lines.find((l) => l.itemKey === "concrete_slat")!;
    expect(slat).toMatchObject({ status: "supplier_quote_required", revenueExTax: null, unitPrice: null });
    expect(ev.readiness.state).toBe("BLOCKED");
    expect(ev.readiness.counts.supplierQuoteRequired).toBeGreaterThan(0);
  });
  it("the estimator can resolve it with a priced amount and a reason — visible as a pricing exception", () => {
    const snap: PriceSnapshot = { ...TEST_SNAPSHOT, entries: { ...TEST_SNAPSHOT.entries, NQ1161: { ...TEST_SNAPSHOT.entries.NQ1161, cost: 0, retailExVat: 0 } } };
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, estimator: { ...d.estimator, priceResolutions: { ...d.estimator.priceResolutions, concrete_slat: { unitPriceExVat: 260, reason: "Supplier quote 2026-10-20" } } } }, { priceSource: createWorkbookPriceSource(snap), withholdCost: false });
    expect(ev.budget!.lines.find((l) => l.itemKey === "concrete_slat")).toMatchObject({ status: "priced", pricedBy: "estimator_resolution", unitPrice: 260 });
    expect(ev.readiness.items.pricingExceptions.map((x) => x.label)).toContain("Concrete slats 1.2m × 0.45m (incl. crane delivery)");
  });
  it("a resolution without a reason is ignored", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, estimator: { ...d.estimator, priceResolutions: { led_light: { unitPriceExVat: 900, reason: "  " } } } }, ctx);
    expect(ev.budget!.lines.find((l) => l.itemKey === "led_light")!.status).not.toBe("priced");
    expect(ev.readiness.state).toBe("BLOCKED");
  });
  it("FORTIS 1.2 has no SKU: the historic FERAX surrogate is never substituted", () => {
    const d = readyDraft();
    const ev = evaluateDraft({ ...d, estimator: { ...d.estimator, priceResolutions: {} } }, ctx);
    const light = ev.budget!.lines.find((l) => l.itemKey === "led_light")!;
    expect(light.status).toBe("package_unconfirmed");
    expect(JSON.stringify(light)).not.toContain("HNQ7046\",\"description");
    expect(light.components!.find((c) => c.id === "luminaire")!.status).toBe("identity_unresolved");
  });
});

describe("a READY golden quote", () => {
  const ev = evaluateDraft(readyDraft(), ctx);
  it("is READY with no blockers and a positive, fully-priced total", () => {
    expect(ev.readiness).toMatchObject({ state: "READY", reasons: [] });
    expect(ev.budget!.state).toBe("complete");
    expect(ev.budget!.totals.subtotalExTax).toBeGreaterThan(0);
  });
});
