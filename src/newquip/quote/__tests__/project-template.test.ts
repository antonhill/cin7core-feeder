import { describe, expect, it } from "vitest";
import { bpsToPercentText, moveRow, percentTextToBps, sameSchedule, stagesFromInput, stagesFromStored } from "../project-template";
import { resolveScheduleChoice, splitContractBySchedule } from "../billing-schedule";

const four = [{ name: "Deposit", percent: "25" }, { name: "Manufacture", percent: "30" }, { name: "Delivery", percent: "30" }, { name: "Install", percent: "15" }];

describe("percent parsing is integer-exact", () => {
  it("never goes through floating point", () => {
    expect(percentTextToBps("27.5")).toBe(2750);
    expect(percentTextToBps("0.07")).toBe(7); // Math.round(0.07 * 100) style code gives 7.000000000000001 territory; here it is exact
    expect(percentTextToBps("33.33")).toBe(3333);
    expect(percentTextToBps("100%")).toBe(10000);
    expect(percentTextToBps("1.005")).toBeNull();
    expect(percentTextToBps("-5")).toBeNull();
    expect(percentTextToBps("abc")).toBeNull();
    expect(percentTextToBps("")).toBeNull();
  });
  it("round-trips", () => {
    for (const b of [1, 7, 500, 2750, 3333, 10000]) expect(percentTextToBps(bpsToPercentText(b))).toBe(b);
  });
});

describe("stagesFromInput: a template must total exactly 100%", () => {
  it("accepts four custom stages and keeps their order", () => {
    const r = stagesFromInput(four);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.stages.map((s) => [s.name, s.bps])).toEqual([["Deposit", 2500], ["Manufacture", 3000], ["Delivery", 3000], ["Install", 1500]]);
  });
  it("rejects 99.99% and 100.01%, duplicates (case-insensitive), blanks, zero and bad numbers", () => {
    const bad = (rows: Array<{ name: string; percent: string }>) => { const r = stagesFromInput(rows); expect(r.ok).toBe(false); return r.ok ? [] : r.errors.join(" "); };
    expect(bad([{ name: "A", percent: "99.99" }])).toMatch(/99\.99%/);
    expect(bad([{ name: "A", percent: "100.01" }])).toMatch(/100\.01%/);
    expect(bad([{ name: "A", percent: "50" }, { name: "a", percent: "50" }])).toMatch(/Duplicate/);
    expect(bad([{ name: " ", percent: "100" }])).toMatch(/name/);
    expect(bad([{ name: "A", percent: "0" }, { name: "B", percent: "100" }])).toMatch(/positive/);
    expect(bad([{ name: "A", percent: "x" }])).toMatch(/not a valid percentage/);
    expect(bad([])).toMatch(/at least one stage/);
  });
});

describe("a four-stage template reconciles exactly to the approved contract", () => {
  const stages = (() => { const r = stagesFromInput(four); if (!r.ok) throw new Error("fixture"); return r.stages; })();
  it("for awkward contract values every stage is an integer and the sum is the contract to the cent", () => {
    for (const contract of [1, 99, 100_01, 12_345_678_99, 4_000_000_00 * 10 + 1, 999_999_99, 3]) {
      const split = splitContractBySchedule(contract, stages);
      expect(split).toHaveLength(4);
      expect(split.every((s) => Number.isInteger(s.valueCents) && s.valueCents >= 0)).toBe(true);
      expect(split.reduce((n, s) => n + s.valueCents, 0)).toBe(contract);
    }
  });
  it("thirds (33.33/33.33/33.34) still reconcile", () => {
    const r = stagesFromInput([{ name: "A", percent: "33.33" }, { name: "B", percent: "33.33" }, { name: "C", percent: "33.34" }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(splitContractBySchedule(10_000_001, r.stages).reduce((n, s) => n + s.valueCents, 0)).toBe(10_000_001);
  });
});

describe("a customised template schedule", () => {
  it("is validated by the same engine as a custom schedule, and reordering is explicit", () => {
    const ok = resolveScheduleChoice({ preset: "TEMPLATE", templateId: "t", stages: [{ name: "Deposit", percent: "50" }, { name: "Rest", percent: "50" }] });
    expect(ok.ok).toBe(true);
    const bad = resolveScheduleChoice({ preset: "TEMPLATE", templateId: "t", stages: [{ name: "Deposit", percent: "50" }, { name: "Rest", percent: "49" }] });
    expect(bad.ok).toBe(false);
    expect(moveRow(["a", "b", "c"], 2, -1)).toEqual(["a", "c", "b"]);
    expect(moveRow(["a", "b"], 0, -1)).toEqual(["a", "b"]);
  });
  it("sameSchedule decides whether a project was customised", () => {
    const base = [{ name: "A", bps: 5000 }, { name: "B", bps: 5000 }];
    expect(sameSchedule(base, [{ name: " A ", bps: 5000 }, { name: "B", bps: 5000 }])).toBe(true);
    expect(sameSchedule(base, [{ name: "A", bps: 6000 }, { name: "B", bps: 4000 }])).toBe(false);
    expect(sameSchedule(base, [{ name: "B", bps: 5000 }, { name: "A", bps: 5000 }])).toBe(false); // order is part of the schedule
  });
});

describe("stored stages are never trusted", () => {
  it("rejects a malformed or non-100% stored list", () => {
    expect(() => stagesFromStored("nope")).toThrow(/malformed/);
    expect(() => stagesFromStored([{ name: "A" }])).toThrow(/malformed/);
    expect(() => stagesFromStored([{ name: "A", bps: 9000 }])).toThrow(/invalid/);
    expect(stagesFromStored([{ name: "A", bps: 10000 }])).toHaveLength(1);
  });
});
