import { describe, expect, it } from "vitest";
import { fromCents } from "@/rwtsa-demo/engine/money";
import { bracketOf, bracketLabels, runProductionVariance, type GroupVariance, type VarianceResult } from "@/rwtsa-demo/engine/production-variance";
import { mfgDataset, type OpSpec, type OrderSpec } from "./mfg-fixture";

const OPS: OpSpec[] = [{ op: "Cut", smv: 10, cpm: 1.5 }, { op: "Sew", smv: 10, cpm: 1.5 }];
// O1: usage +6 m, usage R330.00, price R252.00, recovery 85%, labour R450.00.  O2: usage -9 m, -R495.00, -R351.00, 106.25%, -R450.00.
const O1: OrderSpec = { no: "O1", qty: 100, line: "L1", plannedM: 120, actualM: 126, stdPrice: 55, actPrice: 57, plannedMin: 1700, actualMin: 2000 };
const O2: OrderSpec = { no: "O2", qty: 300, line: "L2", plannedM: 360, actualM: 351, stdPrice: 55, actPrice: 54, plannedMin: 5100, actualMin: 4800 };
const run = (orders: OrderSpec[], ops: OpSpec[] = OPS, cfg = {}) => runProductionVariance(mfgDataset({ orders, ops }), cfg);
const order = (r: VarianceResult, no: string) => r.orders.find((o) => o.orderNo === no)!;
const grp = (gs: readonly GroupVariance[], key: string) => gs.find((g) => g.key === key)!;
const Z = fromCents;

describe("order-level formulas", () => {
  const r = run([O1, O2]);
  it("fabric usage variance = actual - planned (metres)", () => {
    expect(order(r, "O1").usageVarianceM).toBe(6);
    expect(order(r, "O2").usageVarianceM).toBe(-9);
  });
  it("usage variance in rand = (actual - planned quantity) x standard price", () => {
    expect(Z(order(r, "O1").usageVarianceCents!)).toBe(330);
    expect(Z(order(r, "O2").usageVarianceCents!)).toBe(-495);
  });
  it("price variance = actual quantity x (actual price - standard price)", () => {
    expect(Z(order(r, "O1").priceVarianceCents!)).toBe(252);
    expect(Z(order(r, "O2").priceVarianceCents!)).toBe(-351);
  });
  it("labour recovery % = planned minutes / actual minutes x 100", () => {
    expect(order(r, "O1").labourRecoveryPct).toBe(85);
    expect(order(r, "O2").labourRecoveryPct).toBe(106.25);
  });
  it("labour variance = (actual - planned minutes) x cost per minute", () => {
    expect(Z(order(r, "O1").labourVarianceCents!)).toBe(450);
    expect(Z(order(r, "O2").labourVarianceCents!)).toBe(-450);
    expect(order(r, "O1").costPerMinute).toBe(1.5);
  });
  it("cost per minute is the SMV-weighted rate of the style's routing, with its source named", () => {
    const x = run([O1], [{ op: "Cut", smv: 10, cpm: 1 }, { op: "Sew", smv: 30, cpm: 2 }]);
    expect(order(x, "O1").costPerMinute).toBeCloseTo(1.75, 12);
    expect(Z(order(x, "O1").labourVarianceCents!)).toBe(525);
    expect(x.assumptions.map((a) => a.id)).toContain("cost-per-minute");
  });
  it("rand amounts are exact cents, with no floating drift", () => {
    const x = run([{ no: "F", plannedM: 100.1, actualM: 100.4, stdPrice: 55.07, actPrice: 55.13 }]);
    expect(order(x, "F").usageVarianceCents).toBe(Math.round(0.3 * 55.07 * 100));
    expect(order(x, "F").priceVarianceCents).toBe(Math.round(100.4 * 0.06 * 100));
  });
  it("is deterministic and does not mutate its input", () => {
    const ds = mfgDataset({ orders: [O1, O2], ops: OPS });
    const before = JSON.stringify(ds);
    expect(JSON.stringify(runProductionVariance(ds, {}))).toBe(JSON.stringify(runProductionVariance(ds, {})));
    expect(JSON.stringify(ds)).toBe(before);
  });
});

describe("weighted aggregation", () => {
  it("labour recovery aggregates total planned over total actual, not an average of percentages", () => {
    const r = run([O1, O2]);
    const st = grp(r.byStyle, "ST");
    expect(st.plannedMinutes).toBe(6800);
    expect(st.actualMinutes).toBe(6800);
    expect(st.labourRecoveryPct).toBe(100);
    expect((85 + 106.25) / 2).not.toBe(100); // the naive average would be wrong
    expect(Z(st.labourVarianceCents)).toBe(0);
  });
  it("rand variances sum exactly across groups", () => {
    const r = run([O1, O2]);
    const t = r.total;
    expect(Z(t.usageVarianceCents)).toBe(-165);
    expect(Z(t.priceVarianceCents)).toBe(-99);
    for (const groups of [r.byStyle, r.byLine, r.byBracket]) {
      expect(groups.reduce((a, g) => a + g.usageVarianceCents, 0)).toBe(t.usageVarianceCents);
      expect(groups.reduce((a, g) => a + g.priceVarianceCents, 0)).toBe(t.priceVarianceCents);
      expect(groups.reduce((a, g) => a + g.labourVarianceCents, 0)).toBe(t.labourVarianceCents);
      expect(groups.reduce((a, g) => a + g.plannedMinutes, 0)).toBe(t.plannedMinutes);
      expect(groups.reduce((a, g) => a + g.orders, 0)).toBe(2);
    }
  });
  it("groups by production line", () => {
    const r = run([O1, O2, { ...O1, no: "O3", line: "L1" }]);
    expect(grp(r.byLine, "L1").orders).toBe(2);
    expect(grp(r.byLine, "L2").orders).toBe(1);
    expect(grp(r.byLine, "L1").labourRecoveryPct).toBe(85);
  });
  it("groups by style", () => {
    const ops2 = [...OPS, { style: "ST2", op: "Cut", smv: 5, cpm: 2 }];
    const r = run([O1, { ...O2, style: "ST2" }], ops2);
    expect(r.byStyle.map((g) => g.key)).toEqual(["ST", "ST2"]);
    expect(Z(grp(r.byStyle, "ST2").labourVarianceCents)).toBe(-600); // -300 min x R2.00
  });
  it("a group with no actual minutes has no recovery percentage", () => {
    const r = run([{ ...O1, plannedMin: 100, actualMin: 0 }]);
    expect(r.byStyle[0].labourRecoveryPct).toBeNull();
  });
});

describe("order-size brackets", () => {
  it("lower bound inclusive, upper exclusive, open-ended top bracket", () => {
    const b = [100, 250, 500];
    expect(bracketLabels(b)).toEqual(["0-99", "100-249", "250-499", "500+"]);
    for (const [q, label] of [[0, "0-99"], [99, "0-99"], [100, "100-249"], [249, "100-249"], [250, "250-499"], [499, "250-499"], [500, "500+"], [100000, "500+"]] as const) expect(bracketOf(q, b), String(q)).toBe(label);
  });
  it("groups orders into configurable brackets", () => {
    const r = run([O1, O2, { ...O1, no: "O3", qty: 99 }, { ...O1, no: "O4", qty: 250 }], OPS, { bracketBreaks: [100, 250, 500] });
    expect(r.byBracket.map((g) => [g.key, g.orders])).toEqual([["0-99", 1], ["100-249", 1], ["250-499", 2]]);
  });
  it("rejects invalid bracket boundaries", () => {
    for (const bad of [[250, 100], [0, 100], [-5], [100, 100], [1.5], [Number.NaN], Array.from({ length: 13 }, (_, i) => (i + 1) * 10)]) expect(() => run([O1], OPS, { bracketBreaks: bad as number[] }), JSON.stringify(bad)).toThrow(/bracket/i);
  });
});

describe("missing and invalid observations are explicit", () => {
  it("zero actual minutes: no recovery percentage and a stated reason, never a divide by zero", () => {
    const o = order(run([{ ...O1, actualMin: 0 }]), "O1");
    expect(o.labourRecoveryPct).toBeNull();
    expect(o.issues.join(" ")).toMatch(/zero actual minutes/i);
    expect(o.labourVarianceCents).toBeNull(); // not produced yet: no saving is claimed
  });
  it("missing prices leave the rand variances blank, not zero, and the group says how many were included", () => {
    const r = run([{ ...O1, stdPrice: null }, { ...O2, actPrice: null }]);
    expect(order(r, "O1").usageVarianceCents).toBeNull();
    expect(order(r, "O1").priceVarianceCents).toBeNull();
    expect(order(r, "O2").usageVarianceCents).not.toBeNull();
    expect(order(r, "O2").priceVarianceCents).toBeNull();
    const st = grp(r.byStyle, "ST");
    expect(st.usageIncluded).toBe(1);
    expect(st.priceIncluded).toBe(0);
    expect(st.complete).toBe(false);
    expect(Z(st.usageVarianceCents)).toBe(-495);
  });
  it("a style with no routing has no labour rand variance (named), but still has minutes and recovery", () => {
    const r = run([O1], []);
    const o = order(r, "O1");
    expect(o.labourVarianceCents).toBeNull();
    expect(o.costPerMinute).toBeNull();
    expect(o.labourRecoveryPct).toBe(85);
    expect(o.issues.join(" ")).toMatch(/routing/i);
  });
  it("negative or non-finite measurements make the order invalid and exclude it from every total", () => {
    const r = run([O1, { ...O2, actualM: -1 }, { ...O2, no: "O3", plannedMin: Number.NaN }]);
    expect(order(r, "O2").valid).toBe(false);
    expect(order(r, "O3").valid).toBe(false);
    expect(r.total.orders).toBe(1);
    expect(r.warnings.join(" ")).toMatch(/2 order\(s\) with negative or invalid/i);
    expect(r.checks.find((c) => c.id === "valid")!.ok).toBe(false);
  });
  it("an empty ProductionOrders tab gives an empty, honest result", () => {
    const r = run([]);
    expect(r.orders).toEqual([]);
    expect(r.total.labourRecoveryPct).toBeNull();
    expect(r.total.complete).toBe(false);
  });
});

describe("the workbook's own variance columns are reconciled, not trusted", () => {
  it("flags differences from the engine's figures", () => {
    const r = run([{ ...O1, usageVar: 330, priceVar: 200, recovery: 85 }]);
    const o = order(r, "O1");
    expect(o.workbookDiff.usageCents).toBe(0);
    expect(Z(o.workbookDiff.priceCents!)).toBe(-52); // workbook - engine
    expect(o.workbookDiff.recoveryPct).toBe(0);
    expect(r.checks.find((c) => c.id === "workbook-columns")!.ok).toBe(false);
  });
  it("is silent when the workbook gives none", () => {
    const r = run([O1]);
    expect(order(r, "O1").workbookDiff.usageCents).toBeNull();
    expect(r.checks.find((c) => c.id === "workbook-columns")!.ok).toBe(true);
  });
});

describe("reconciliation checks", () => {
  it("all pass on clean data", () => {
    const r = run([O1, O2]);
    expect(r.checks.length).toBeGreaterThanOrEqual(5);
    expect(r.checks.every((c) => c.ok)).toBe(true);
  });
});

describe("review hardening: unobserved (zero-actual) orders", () => {
  const notBuilt: OrderSpec = { no: "A", plannedM: 100, actualM: 0, plannedMin: 100, actualMin: 0 };
  const built: OrderSpec = { no: "B", plannedM: 100, actualM: 100, plannedMin: 100, actualMin: 100 };
  it("an order with no actual minutes does not enter recovery or labour aggregation, and the group is partial", () => {
    const r = run([notBuilt, built]);
    const g = r.byStyle[0];
    expect(g.labourRecoveryPct).toBe(100); // B only, not 200%
    expect(g.plannedMinutes).toBe(100);
    expect(g.actualMinutes).toBe(100);
    expect(g.labourVarianceCents).toBe(0);
    expect(g.labourIncluded).toBe(1);
    expect(g.orders).toBe(2);
    expect(g.complete).toBe(false);
    expect(r.total.complete).toBe(false);
  });
  it("zero actual fabric against a planned quantity is not booked as a saving", () => {
    const r = run([notBuilt, built]);
    expect(order(r, "A").usageVarianceCents).toBeNull();
    expect(order(r, "A").priceVarianceCents).toBeNull();
    expect(r.byStyle[0].usageVarianceCents).toBe(0);
    expect(r.byStyle[0].usageIncluded).toBe(1);
  });
  it("an order with zero planned and zero actual is a valid observation", () => {
    const r = run([{ no: "Z", plannedM: 0, actualM: 0, plannedMin: 0, actualMin: 0 }]);
    expect(order(r, "Z").usageVarianceCents).toBe(0);
  });
});
