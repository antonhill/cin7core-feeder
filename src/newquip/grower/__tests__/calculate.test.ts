import { describe, expect, it } from "vitest";
import { calculateGrowerHouse, evaluateRule, validateGrowerInput } from "../calculate";
import { GROWER_RULES, type GrowerRuleDef } from "../rules";
import { TOPIGS_FLOOR_AREA_M2, TOPIGS_GROWER_HISTORIC, TOPIGS_GROWER_INPUT } from "../fixture";
import type { GrowerConfigurationInput } from "../types";

const clone = (o: Partial<GrowerConfigurationInput> = {}): GrowerConfigurationInput => ({ ...structuredClone(TOPIGS_GROWER_INPUT), ...o });

describe("A. VERIFIED calculations (golden Topigs input)", () => {
  const r = calculateGrowerHouse(TOPIGS_GROWER_INPUT);

  it("derives the floor area as length × width (workbook B77)", () => {
    expect(r.valid).toBe(true);
    expect(r.derived.floorAreaM2).toBeCloseTo(TOPIGS_FLOOR_AREA_M2, 6);
    expect(r.derived.rooms).toBe(12);
  });

  it("emits NO system-calculated quantity while no item rule is verified", () => {
    expect(r.lines.some((l) => l.basis === "system_calculated")).toBe(false);
    expect(r.lines.some((l) => l.ruleStatus === "verified")).toBe(false);
  });

  it("every non-optional line is awaiting validation with a null quantity", () => {
    for (const l of r.lines.filter((x) => x.basis !== "not_selected")) {
      expect(l.basis).toBe("awaiting_validation");
      expect(l.quantityPerRoom).toBeNull();
      expect(l.projectQuantity).toBeNull();
    }
  });

  it("optional equipment that is switched off is a real 0, not_selected", () => {
    for (const k of Object.keys(TOPIGS_GROWER_INPUT.optionalEquipment)) {
      const l = r.lines.find((x) => x.itemKey === k)!;
      expect(l.basis).toBe("not_selected");
      expect(l.quantityPerRoom).toBe(0);
    }
  });
});

describe("B. historic reference outputs awaiting rule validation", () => {
  const r = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
  it("carries the Topigs historic quantity on every line as REFERENCE ONLY", () => {
    for (const l of r.lines) {
      expect(l.historicReference.quantityPerRoom).toBe(TOPIGS_GROWER_HISTORIC[l.itemKey]);
      // the historic figure never leaks into the calculated quantity
      if (l.basis === "awaiting_validation") expect(l.quantityPerRoom).toBeNull();
    }
  });

  it("hypotheses are displayed but are labelled awaiting validation and never priced", () => {
    const by = Object.fromEntries(r.lines.map((l) => [l.itemKey, l]));
    // These hypothesis VALUES are computed from the inputs (not hard-coded). That they reproduce the
    // historic figure is an observation to put to NewQuip, not a verification.
    expect(by.feeder.hypothesis?.value).toBe(18);
    expect(by.feed_saver_mat.hypothesis?.value).toBe(18);
    expect(by.cup_drinker.hypothesis?.value).toBe(54);
    expect(by.concrete_slat.hypothesis?.value).toBe(1320);
    expect(by.led_light.hypothesis?.value).not.toBe(TOPIGS_GROWER_HISTORIC.led_light); // guide cell contradicts history
    expect(by.feeder.ruleStatus).toBe("requires_validation");
    expect(by.feed_saver_mat.ruleStatus).toBe("provisional");
    for (const l of Object.values(by).filter((x) => x.basis !== "not_selected")) expect(l.projectQuantity).toBeNull();
  });

  it("hypotheses follow the inputs (not hard-coded to Topigs)", () => {
    const r2 = calculateGrowerHouse(clone({ totalPens: 30, hospitalPens: 4, lengthM: 36, widthM: 12 }));
    const by = Object.fromEntries(r2.lines.map((l) => [l.itemKey, l]));
    expect(by.feeder.hypothesis?.value).toBe(26);
    expect(by.concrete_slat.hypothesis?.value).toBe(80 * 10);
  });

  it("slat hypothesis tolerates binary float error (49.5/0.45)", () => {
    expect(calculateGrowerHouse(TOPIGS_GROWER_INPUT).lines.find((l) => l.itemKey === "concrete_slat")!.hypothesis?.value).toBe(1320);
  });
});

describe("a promoted (verified) rule plugs in cleanly", () => {
  const def: GrowerRuleDef = {
    ...GROWER_RULES.find((d) => d.itemKey === "feeder")!,
    classification: "verified",
    verifiedCompute: (i) => i.totalPens - i.hospitalPens,
  };
  it("is system_calculated and multiplied by rooms by the caller", () => {
    expect(evaluateRule(def, TOPIGS_GROWER_INPUT)).toEqual({ basis: "system_calculated", quantityPerRoom: 18 });
  });
  it("an unverified rule with verifiedCompute attached is still NOT calculated", () => {
    expect(evaluateRule({ ...def, classification: "requires_validation" }, TOPIGS_GROWER_INPUT).basis).toBe("awaiting_validation");
  });
});

describe("overrides", () => {
  it("a manual override supplies the quantity, flagged manual, ×rooms", () => {
    const r = calculateGrowerHouse(clone({ quantityOverrides: { feeder: 18 } }));
    const l = r.lines.find((x) => x.itemKey === "feeder")!;
    expect(l).toMatchObject({ basis: "manual_override", quantityPerRoom: 18, projectQuantity: 216, overrideState: "manual_override", ruleStatus: "requires_validation" });
    expect(l.explanation.kind).toBe("manual");
  });
  it("an override on an optional item that is off stays 0 / not_selected", () => {
    const r = calculateGrowerHouse(clone({ quantityOverrides: { manure_plug: 5 } }));
    expect(r.lines.find((x) => x.itemKey === "manure_plug")!.quantityPerRoom).toBe(0);
  });
  it("a selected optional item awaits a manual entry", () => {
    const r = calculateGrowerHouse(clone({ optionalEquipment: { ...TOPIGS_GROWER_INPUT.optionalEquipment, cone_fans: true } }));
    expect(r.lines.find((x) => x.itemKey === "cone_fans")!.basis).toBe("awaiting_validation");
  });
});

describe("purity", () => {
  it("same input → deep-equal output, and the input is not mutated", () => {
    const input = clone({ quantityOverrides: { feeder: 3 } });
    const snapshot = structuredClone(input);
    const a = calculateGrowerHouse(input);
    const b = calculateGrowerHouse(input);
    expect(a).toEqual(b);
    expect(input).toEqual(snapshot);
  });
});

describe("invalid inputs", () => {
  const cases: [string, Partial<GrowerConfigurationInput>, string][] = [
    ["zero rooms", { rooms: 0 }, "rooms"],
    ["negative rooms", { rooms: -1 }, "rooms"],
    ["fractional rooms", { rooms: 2.5 }, "rooms"],
    ["zero total pens", { totalPens: 0 }, "totalPens"],
    ["negative hospital pens", { hospitalPens: -1 }, "hospitalPens"],
    ["hospital > total", { hospitalPens: 21 }, "hospitalPens"],
    ["zero length", { lengthM: 0 }, "lengthM"],
    ["NaN width", { widthM: NaN }, "widthM"],
    ["Infinity pigs", { pigsPerBuilding: Infinity }, "pigsPerBuilding"],
  ];
  for (const [name, patch, field] of cases) {
    it(`rejects ${name} and generates no lines (never a negative quantity)`, () => {
      const r = calculateGrowerHouse(clone(patch));
      expect(r.valid).toBe(false);
      expect(r.issues.some((i) => i.field === field)).toBe(true);
      expect(r.lines).toEqual([]);
    });
  }
  it("rejects a negative override", () => {
    const r = calculateGrowerHouse(clone({ quantityOverrides: { feeder: -4 } }));
    expect(r.valid).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain("negative_override");
  });
  it("zero hospital pens is valid", () => {
    expect(validateGrowerInput(clone({ hospitalPens: 0 }))).toEqual([]);
  });
  it("an unsupported selection raises an issue and drops that line rather than guessing", () => {
    const r = calculateGrowerHouse(clone({ selectedFeederType: "CAWI" }));
    expect(r.valid).toBe(true);
    expect(r.issues.map((i) => i.code)).toContain("unsupported_selection");
    expect(r.lines.find((l) => l.itemKey === "feeder")).toBeUndefined();
  });
});

describe("explainability is data-driven", () => {
  const r = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
  it("provisional/awaiting lines show historic, hypothesis and status", () => {
    const f = r.lines.find((l) => l.itemKey === "feeder")!;
    expect(f.explanation.kind).toBe("awaiting");
    expect(f.explanation.steps.join("\n")).toContain("Historic Topigs quantity: 18 per room");
    expect(f.explanation.steps.join("\n")).toContain("20 total pens − 2 hospital pens = 18");
    expect(f.explanation.steps.join("\n")).toContain("awaiting NewQuip validation");
    expect(r.lines.find((l) => l.itemKey === "feed_saver_mat")!.explanation.kind).toBe("provisional");
  });
  it("an item with no proposed relationship says so", () => {
    const t = r.lines.find((l) => l.itemKey === "bulk_tank")!;
    expect(t.explanation.steps.join("\n")).toContain("No relationship has been proposed");
  });
  it("every line has a non-empty explanation and inputsUsed is derived from the rule", () => {
    for (const l of r.lines) expect(l.explanation.steps.length).toBeGreaterThan(0);
    expect(r.lines.find((l) => l.itemKey === "feeder")!.inputsUsed).toMatchObject({ totalPens: 20, hospitalPens: 2 });
  });
});
