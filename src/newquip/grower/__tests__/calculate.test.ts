import { describe, expect, it } from "vitest";
import { calculateGrowerHouse, evaluateRule, validateGrowerInput } from "../calculate";
import { GROWER_RULES, type GrowerRuleDef } from "../rules";
import { TOPIGS_FLOOR_AREA_M2, TOPIGS_GROWER_HISTORIC, TOPIGS_GROWER_INPUT } from "../fixture";
import type { GrowerConfigurationInput } from "../types";

const clone = (o: Partial<GrowerConfigurationInput> = {}): GrowerConfigurationInput => ({ ...structuredClone(TOPIGS_GROWER_INPUT), ...o });

describe("A. confirmed calculations (golden Topigs input)", () => {
  const r = calculateGrowerHouse(TOPIGS_GROWER_INPUT);

  it("derives the floor area as length × width (workbook B77)", () => {
    expect(r.valid).toBe(true);
    expect(r.derived.floorAreaM2).toBeCloseTo(TOPIGS_FLOOR_AREA_M2, 6);
    expect(r.derived.rooms).toBe(12);
  });

  it("lighting is the only line that yields a quantity before the estimator has entered anything: a labelled DEFAULT", () => {
    for (const l of r.lines.filter((x) => x.basis !== "not_selected" && x.itemKey !== "led_light")) {
      expect(l.basis).toBe("awaiting_validation");
      expect(l.quantityPerRoom).toBeNull();
      expect(l.projectQuantity).toBeNull();
    }
    const light = r.lines.find((l) => l.itemKey === "led_light")!;
    expect(light.basis).toBe("system_default");
    expect(light.quantityPerRoom).toBe(29); // ceil(714.285 / 25) — Sean's own "about 29"
    expect(light.projectQuantity).toBe(29 * 12);
  });

  it("optional equipment that is switched off is a real 0, not_selected", () => {
    for (const k of Object.keys(TOPIGS_GROWER_INPUT.optionalEquipment)) {
      const l = r.lines.find((x) => x.itemKey === k)!;
      expect(l.basis).toBe("not_selected");
      expect(l.quantityPerRoom).toBe(0);
    }
  });
});

describe("B. historic reference outputs are never quantities", () => {
  const r = calculateGrowerHouse(TOPIGS_GROWER_INPUT);
  it("carries the Topigs historic quantity on every line as REFERENCE ONLY", () => {
    for (const l of r.lines) {
      expect(l.historicReference.quantityPerRoom).toBe(TOPIGS_GROWER_HISTORIC[l.itemKey]);
      if (l.basis === "awaiting_validation") expect(l.quantityPerRoom).toBeNull();
    }
  });
  it("the mat default follows the estimator-confirmed feeder quantity and is empty until then", () => {
    expect(r.lines.find((l) => l.itemKey === "feed_saver_mat")!.basis).toBe("awaiting_validation");
    const r2 = calculateGrowerHouse(clone({ estimatorQuantities: { feeder: 14 } }));
    const mat = r2.lines.find((l) => l.itemKey === "feed_saver_mat")!;
    expect(mat).toMatchObject({ basis: "system_default", quantityPerRoom: 14, projectQuantity: 14 * 12 });
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
    expect(l).toMatchObject({ basis: "manual_override", quantityPerRoom: 18, projectQuantity: 216, overrideState: "manual_override", ruleStatus: "manual" });
    expect(l.explanation.kind).toBe("manual");
  });
  it("an override on an optional item that is off stays 0 / not_selected", () => {
    const r = calculateGrowerHouse(clone({ quantityOverrides: { manure_plug: 5 } }));
    expect(r.lines.find((x) => x.itemKey === "manure_plug")!.quantityPerRoom).toBe(0);
  });
  it("a selected optional item awaits an estimator entry (engineering review)", () => {
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
    ["Infinity pigs", { pigsPerRoom: Infinity }, "pigsPerRoom"],
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
  it("awaiting lines show historic, capacity basis and the rule evidence", () => {
    const f = r.lines.find((l) => l.itemKey === "feeder")!;
    expect(f.explanation.steps.join("\n")).toContain("Historic Topigs quantity: 18 per room");
    expect(f.explanation.steps.join("\n")).toContain("45 pigs per feeder");
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
