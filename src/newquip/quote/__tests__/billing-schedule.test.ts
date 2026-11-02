import { describe, expect, it } from "vitest";
import { percentToBps, resolveScheduleChoice, NEWQUIP_STANDARD_SCHEDULE, POC_SIX_STAGE_SCHEDULE, VARIATION_DEFAULT_SCHEDULE, splitContractBySchedule, validateSchedule } from "../billing-schedule";
import { splitContractIntoStages } from "../to-project";

const R = (n: number) => n * 100;

describe("NewQuip standard 40/55/5 billing schedule", () => {
  it("is valid and is the default for new projects", () => {
    expect(validateSchedule(NEWQUIP_STANDARD_SCHEDULE).ok).toBe(true);
    expect(splitContractIntoStages(R(10_000_000)).map((s) => [s.name, s.valueCents])).toEqual([["Deposit", R(4_000_000)], ["Delivery", R(5_500_000)], ["Installation", R(500_000)]]);
  });
  it("R100,000 -> R40,000 / R55,000 / R5,000", () => {
    expect(splitContractBySchedule(R(100_000)).map((s) => s.valueCents)).toEqual([R(40_000), R(55_000), R(5_000)]);
  });
  it("handles cent rounding: the last stage absorbs it and the total is exact", () => {
    const stages = splitContractBySchedule(10_001);
    expect(stages.reduce((a, s) => a + s.valueCents, 0)).toBe(10_001);
    expect(stages.map((s) => s.valueCents)).toEqual([4_000, 5_500, 501]);
  });
  it("supports alternative schedules, additional delivery draws and the variation default", () => {
    const draws = [{ name: "Deposit", bps: 4000, description: "", trigger: "" }, { name: "Delivery 1", bps: 3000, description: "", trigger: "" }, { name: "Delivery 2", bps: 2500, description: "", trigger: "" }, { name: "Commissioning", bps: 500, description: "", trigger: "" }];
    expect(splitContractBySchedule(R(1_000_000), draws).map((s) => s.valueCents)).toEqual([R(400_000), R(300_000), R(250_000), R(50_000)]);
    expect(validateSchedule(POC_SIX_STAGE_SCHEDULE).ok).toBe(true);
    expect(splitContractBySchedule(R(5_000), VARIATION_DEFAULT_SCHEDULE).map((s) => s.valueCents)).toEqual([R(5_000)]);
  });
  it("rejects schedules that do not total 100%, are empty, or have duplicate / non-positive stages", () => {
    expect(validateSchedule([{ name: "A", bps: 4000 }, { name: "B", bps: 5000 }]).errors.join()).toMatch(/90\.00%/);
    expect(validateSchedule([]).ok).toBe(false);
    expect(validateSchedule([{ name: "A", bps: 5000 }, { name: "a", bps: 5000 }]).errors.join()).toMatch(/Duplicate/);
    expect(validateSchedule([{ name: "A", bps: 10_000 }, { name: "B", bps: 0 }]).ok).toBe(false);
    expect(() => splitContractBySchedule(100, [{ name: "A", bps: 5000, description: "", trigger: "" }])).toThrow(/Invalid billing schedule/);
  });
});

describe("schedule picker resolution", () => {
  it("defaults to the standard schedule; presets resolve; custom schedules are validated", () => {
    expect(resolveScheduleChoice()).toMatchObject({ ok: true, label: "NewQuip standard 40/55/5" });
    expect(resolveScheduleChoice({ preset: "SIX_STAGE" })).toMatchObject({ ok: true });
    const c = resolveScheduleChoice({ preset: "CUSTOM", stages: [{ name: "Deposit", percent: "30" }, { name: "Delivery 1", percent: "30%" }, { name: "Delivery 2", percent: "27.5" }, { name: "Install", percent: "12.5" }] });
    expect(c.ok && splitContractBySchedule(R(1_000_000), c.schedule).map((s) => s.valueCents)).toEqual([R(300_000), R(300_000), R(275_000), R(125_000)]);
  });
  it("rejects custom schedules that do not total 100%, have bad numbers, or duplicate names", () => {
    const bad = (stages: Array<{ name: string; percent: string }>) => resolveScheduleChoice({ preset: "CUSTOM", stages });
    expect(bad([{ name: "A", percent: "50" }, { name: "B", percent: "40" }])).toMatchObject({ ok: false });
    expect(bad([{ name: "A", percent: "abc" }, { name: "B", percent: "100" }])).toMatchObject({ ok: false });
    expect(bad([{ name: "A", percent: "50" }, { name: "A", percent: "50" }])).toMatchObject({ ok: false });
    expect(bad([])).toMatchObject({ ok: false });
    expect(resolveScheduleChoice({ preset: "BOGUS" as never })).toMatchObject({ ok: false });
  });
  it("parses percentages exactly to basis points", () => {
    expect([percentToBps("40"), percentToBps("27.5"), percentToBps("12.25%"), percentToBps("0.01")]).toEqual([4000, 2750, 1225, 1]);
    expect([percentToBps("1.234"), percentToBps("-5"), percentToBps(""), percentToBps("1e2")]).toEqual([null, null, null, null]);
  });
});
