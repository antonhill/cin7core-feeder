// NEWQUIP GROWER PRICING HANDOFF 2026-11-25: the CONFIRMED rules only. Every open commercial question stays open (see docs/newquip/NEWQUIP_GROWER_PRICING_IMPLEMENTATION_MATRIX.md).
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { packageAutoConfirmable, packageFor } from "../commercial";
import { coolingBom } from "../cooling-bom";
import { calculateGrowerHouse } from "../calculate";
import { nqQ0002, S } from "./nq-q-0002-fixture";

const ctx = { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false, provisionalPackages: true };
const lineOf = (d: QuoteDraft, k: string) => evaluateDraft(d, ctx).budget!.lines.find((l) => l.itemKey === k)!;
const withPlug = (qty: number, costs: Record<string, number>): QuoteDraft => {
  const d = structuredClone(nqQ0002());
  d.config.optionalEquipment = { ...d.config.optionalEquipment, manure_plug: true } as never;
  d.config.estimatorQuantities = { ...d.config.estimatorQuantities, manure_plug: qty } as never;
  for (const [sku, e7] of Object.entries(costs)) (d.estimator.pricing!.skus as Record<string, unknown>)[sku] = S("ZAR", e7);
  return d;
};

describe("250 mm manure plug: MNQ048 = MNQ039 + MNQ040 + MNQ041, quantity entered by the Rep", () => {
  it("is exactly one each of the three components, and carries the same Estimator sign-off as every other package", () => {
    expect(packageFor("manure_plug", "grower-2026-11")!.components.map((c) => [c.sku, c.qtyPerUnit])).toEqual([["MNQ039", 1], ["MNQ040", 1], ["MNQ041", 1]]);
    expect(packageAutoConfirmable(packageFor("manure_plug", "grower-2026-11"))).toBe(false); // the Estimator signs it off like every other package
  });
  it("prices from current component costs x the Rep's quantity (cost 100 + 200 + 300 per plug; 4 per room x 12 rooms = 48; 1.15 freight, 20% markup)", () => {
    const l = lineOf(withPlug(4, { MNQ039: 1_000_000_000, MNQ040: 2_000_000_000, MNQ041: 3_000_000_000 }), "manure_plug");
    expect(l.status).toBe("priced");
    expect(l.quantity).toBe(48); // the Rep's per-room quantity x the 12 rooms
    expect(l.provisional).toBeDefined(); // Budget-priced, awaiting the Estimator's sign-off
    expect(l.revenueExTax).toBeCloseTo(48 * 600 * 1.15 * 1.2, 2);
  });
  it("is NOT priced when a component has no cost: a cost is never invented, and a partial package is never a price", () => {
    const l = lineOf(withPlug(4, { MNQ039: 1_000_000_000, MNQ040: 2_000_000_000 }), "manure_plug");
    expect(l.status).not.toBe("priced");
    expect(l.revenueExTax).toBeNull();
  });
  it("an unconfirmed quantity is not invented: with no quantity entered the line is not priced", () => {
    const d = withPlug(0, { MNQ039: 1_000_000_000, MNQ040: 2_000_000_000, MNQ041: 3_000_000_000 });
    delete (d.config.estimatorQuantities as Record<string, unknown>).manure_plug;
    expect(lineOf(d, "manure_plug").revenueExTax).toBeNull();
  });
  it("a quotation created under the ORIGINAL template is unchanged: the plug stays unmapped", () => {
    const d = withPlug(4, { MNQ039: 1_000_000_000, MNQ040: 2_000_000_000, MNQ041: 3_000_000_000 });
    delete (d.estimator as { templateRevision?: string }).templateRevision;
    expect(lineOf(d, "manure_plug").status).not.toBe("priced");
  });
});

describe("customer-facing names (current template only)", () => {
  it("the cup drinker reads 'Sow Cup Drinker Including Mounting Material'; the LED's FERAX rename is HELD (the Rep-safe document guard forbids that brand until the owner decides), so it is unchanged", () => {
    const d = nqQ0002();
    expect(lineOf(d, "cup_drinker").label).toBe("Sow Cup Drinker Including Mounting Material");
    expect(lineOf(d, "led_light").label).toMatch(/FORTIS 1\.2/);
  });
  it("a quotation created under the original template keeps its original wording", () => {
    const d = structuredClone(nqQ0002()); delete (d.estimator as { templateRevision?: string }).templateRevision;
    expect(lineOf(d, "cup_drinker").label).not.toBe("Sow Cup Drinker Including Mounting Material");
  });
  it("the cup drinker is the SEVEN-component list, never NB3542-03", () => {
    const c = lineOf(nqQ0002(), "cup_drinker").components!;
    expect(c.map((x) => x.sku)).toEqual(["QCA00003", "NQ1380", "NQ2784", "NQ2886", "NQ1386", "NYNUT", "NQ1017"]);
    expect(c.map((x) => x.sku)).not.toContain("NB3542-03");
  });
});

describe("sumpless pad cooling: the confirmed quantities (pure; not yet wired into a quotation)", () => {
  const q = (L: number) => Object.fromEntries(coolingBom(L).lines.map((l) => [l.sku, l.quantity]));
  it("reproduces the handoff's 12 m example exactly", () => {
    expect(q(12)).toMatchObject({ KNQCOOL02: 1, KNQCOOL03: 3, KNQCOOL16: 2, KNQCOOL04: 1, KNQCOOL01: 20, NQ2550: 18, NYNUT: 108, NQ1964: 54 });
    expect(q(12)).toMatchObject({ NQ3330: 4, NQ3331: 10, NQ3332: 4, NQ3333: 1, NQ3334: 1, NQ3335: 1, NQ3336: 1, NQ2968: 1, N3771: 1, NQ3339: 1, NQ3340: 1, NQ3338: 3, NQ3341: 1, NQ1118: 1, NQ3368: 1, NQ1211: 11, NQ1342: 11, NQ1029: 6, NQ1089: 6, NQ3275: 6, NQ3382: 1, NQ1532: 2, NQ2185: 3 });
    expect(coolingBom(12).plumbingDoubled).toBe(false);
  });
  it("rounds acetone and Sikaflex (1.5) UP to 2 containers", () => expect(q(12)).toMatchObject({ NQ3369: 2, NQ3344: 2 }));
  it("a length rounds up to the next 3 m section (middle kits = ceil(L/3) - 1) and the pads to ceil(L/0.6)", () => {
    expect(q(3)).toMatchObject({ KNQCOOL03: 0, KNQCOOL01: 5 });
    expect(q(3.1)).toMatchObject({ KNQCOOL03: 1, KNQCOOL01: 6 });
    expect(q(9)).toMatchObject({ KNQCOOL03: 2, KNQCOOL01: 15 });
    expect(q(10)).toMatchObject({ KNQCOOL03: 3, KNQCOOL01: 17 });
  });
  it("threaded rods = 4 x (basic + middle) + 2 x tank kit; nuts = rods x 6; washers = rods x 3", () => {
    for (const L of [3, 6, 12, 18, 20, 25]) {
      const m = q(L); const rods = 4 * (m.KNQCOOL02 + m.KNQCOOL03) + 2 * m.KNQCOOL04;
      expect([m.NQ2550, m.NYNUT, m.NQ1964]).toEqual([rods, rods * 6, rods * 3]);
    }
  });
  it("BOUNDARY: exactly 20 m keeps the standard plumbing; 20.01 m doubles every plumbing quantity", () => {
    const at20 = q(20), over = q(20.01);
    expect(coolingBom(20).plumbingDoubled).toBe(false);
    expect(coolingBom(20.01).plumbingDoubled).toBe(true);
    expect(at20).toMatchObject({ NQ3330: 4, NQ3331: 10, NQ1118: 1, NQ3341: 1, NQ3369: 2, NQ3344: 2, NQ2185: 3 });
    expect(over).toMatchObject({ NQ3330: 8, NQ3331: 20, NQ1118: 2, NQ3341: 2, NQ3369: 3, NQ3344: 3, NQ2185: 6, NQ1532: 4 });
  });
  it("over 20 m the gutter section does not double: KNQCOOL16 stays 2, and the water tank kit stays 1", () => {
    expect(q(25)).toMatchObject({ KNQCOOL16: 2, KNQCOOL04: 1 });
  });
  it("states its three open readings instead of hiding them", () => expect(coolingBom(12).assumptions).toHaveLength(3));
  it("refuses a length that is not a positive number", () => {
    for (const L of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => coolingBom(L)).toThrow(/greater than zero/);
  });
  it("lists no SKU twice (the cleaning fitting is counted once)", () => {
    const skus = coolingBom(12).lines.map((l) => l.sku);
    expect(new Set(skus).size).toBe(skus.length);
  });
});

describe("sumpless pad cooling inside a NEW quotation (current template)", () => {
  const withCooling = (lengthM: number | null | undefined, systemsPerRoom = 1, priced = true): QuoteDraft => {
    const d = structuredClone(nqQ0002());
    d.config.optionalEquipment = { ...d.config.optionalEquipment, pad_cooling: true } as never;
    d.config.estimatorQuantities = { ...d.config.estimatorQuantities, pad_cooling: systemsPerRoom } as never;
    if (lengthM !== undefined) d.config.coolingSystemLengthM = lengthM;
    if (priced && lengthM) for (const l of coolingBom(lengthM).lines) (d.estimator.pricing!.skus as Record<string, unknown>)[l.sku] = S("ZAR", 1_000_000_000); // every component R100.00 (a test figure)
    return d;
  };
  const unitsOf = (L: number) => coolingBom(L).lines.reduce((a, l) => a + l.quantity, 0);
  it("with a length the line is priced provisionally from component quantities x 1 system x 12 rooms (R100 test cost, 1.15 freight, 20% markup)", () => {
    const l = lineOf(withCooling(12), "pad_cooling");
    expect(l.status).toBe("priced");
    expect(l.provisional).toBeDefined();
    expect(l.quantity).toBe(12);
    expect(l.revenueExTax).toBeCloseTo(12 * unitsOf(12) * 100 * 1.15 * 1.2, 2);
    expect(l.components!.find((c) => c.sku === "KNQCOOL01")!.quantity).toBe(12 * 20); // 20 pads per 12 m system
  });
  it("every plumbing quantity doubles just over 20 m (boundary: 20 m vs 20.01 m)", () => {
    const at20 = lineOf(withCooling(20), "pad_cooling"), over = lineOf(withCooling(20.01), "pad_cooling");
    expect(at20.status).toBe("priced"); expect(over.status).toBe("priced");
    expect(over.components!.find((c) => c.sku === "NQ1118")!.quantity).toBe(2 * 12);
    expect(at20.components!.find((c) => c.sku === "NQ1118")!.quantity).toBe(12);
    expect(over.components!.find((c) => c.sku === "KNQCOOL16")!.quantity).toBe(2 * 12);
  });
  it("NO length: the line is NOT priced, says what to enter, and no length is guessed", async () => {
    for (const L of [null, undefined] as const) {
      const l = lineOf(withCooling(L as never, 1, false), "pad_cooling");
      expect(l.status).toBe("unmapped");
      expect(l.revenueExTax).toBeNull();
      expect(l.reason).toMatch(/length of one cooling system/);
    }
    // a zero or negative length is an invalid input: nothing is priced at all
    for (const L of [0, -3]) expect(evaluateDraft(withCooling(L, 1, false), ctx).budget).toBeNull();
    const { repNextStepFor } = await import("../budget-coverage");
    expect(repNextStepFor("pad_cooling")).toMatch(/Enter the length of one cooling system/);
  });
  it("a missing component cost leaves the whole package unpriced (a cost is never invented)", () => {
    const d = withCooling(12); delete (d.estimator.pricing!.skus as Record<string, unknown>).NQ1118;
    expect(lineOf(d, "pad_cooling").status).not.toBe("priced");
  });
  it("a quotation on the ORIGINAL template ignores the length and stays unmapped", () => {
    const d = withCooling(12); delete (d.estimator as { templateRevision?: string }).templateRevision;
    expect(lineOf(d, "pad_cooling").status).not.toBe("priced");
  });
  it("the length is validated by the calculation (a negative or non-numeric length is refused) and a NEW draft carries no length", () => {
    const d = withCooling(-1, 1, false);
    expect(calculateGrowerHouse(d.config).issues.map((i) => i.field)).toContain("coolingSystemLengthM");
    expect("coolingSystemLengthM" in nqQ0002().config).toBe(false);
  });
  it("Rep-safe: the Budget summary names no cooling product code or supplier", async () => {
    const { budgetPricingOf } = await import("../budget-pricing");
    const v = JSON.stringify(budgetPricingOf(evaluateDraft(withCooling(12), ctx).budget!));
    expect(v).not.toMatch(/KNQCOOL|NQ3330|NQ1118|supplier|freight|markup|margin/i);
  });
});
