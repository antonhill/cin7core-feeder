import { describe, expect, it } from "vitest";
import { allocateCents, fromCents, toCents } from "@/rwtsa-demo/engine/money";
import { dutyOnCustomsValue, runLandedCost, type LandedLine, type LandedResult } from "@/rwtsa-demo/engine/landed-cost";
import { landedDataset, type LineSpec } from "./landed-fixture";

const run = (lines: LineSpec[], cfg = {}) => runLandedCost(landedDataset(lines), cfg);
const line = (r: LandedResult, shipment: string, sku: string): LandedLine => {
  const l = r.lines.find((x) => x.shipmentRef === shipment && x.sku === sku);
  if (!l) throw new Error("no line " + shipment + "/" + sku);
  return l;
};
const Z = fromCents;

// Shipment S1: freight R9,000 over CBM 1:2:3 -> 1,500 / 3,000 / 4,500.
const S1: LineSpec[] = [
  { shipment: "S1", sku: "A", qty: 100, fobUsd: 1000, planningFx: 18, customsFx: 19, duty: 500, cbm: 1, freight: 9000 },
  { shipment: "S1", sku: "B", qty: 50, fobUsd: 400, planningFx: 18, customsFx: 19, duty: 200, cbm: 2, freight: 9000 },
  { shipment: "S1", sku: "C", qty: 10, fobUsd: 100, planningFx: 18, customsFx: 19, duty: 50, cbm: 3, freight: 9000 },
];

describe("money in integer cents", () => {
  it("rounds half away from zero, deterministically", () => {
    expect(toCents(1.005)).toBe(101);
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(-1.005)).toBe(-101);
    expect(toCents(618.4815)).toBe(61848);
    expect(Z(61848)).toBe(618.48);
  });
  it("allocateCents splits exactly (largest remainder, ties by position)", () => {
    expect(allocateCents(10000, [1, 1, 1])).toEqual([3334, 3333, 3333]);
    expect(allocateCents(900000, [1, 2, 3])).toEqual([150000, 300000, 450000]);
    expect(allocateCents(5, [1, 0])).toEqual([5, 0]);
    expect(allocateCents(0, [1, 2])).toEqual([0, 0]);
    expect(allocateCents(100, [0, 0])).toBeNull();
    expect(allocateCents(100, [])).toBeNull();
  });
  it("allocateCents always sums to the total, for many awkward weights", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < 300; i++) {
      const n = 1 + Math.floor(rnd() * 9);
      const w = Array.from({ length: n }, () => (rnd() < 0.15 ? 0 : Math.round(rnd() * 1000) / 7));
      if (w.every((x) => x === 0)) continue;
      const total = Math.floor(rnd() * 5_000_000);
      const parts = allocateCents(total, w)!;
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      expect(parts.every((p, k) => Number.isInteger(p) && p >= 0 && (w[k] > 0 || p === 0))).toBe(true);
    }
  });
});

describe("1-2 FOB in ZAR at customs FX, and duty on customs value", () => {
  it("customs value = FOB USD x customs FX", () => {
    const l = line(run(S1), "S1", "A");
    expect(Z(l.customsValueCents!)).toBe(19000);
    expect(Z(l.planningValueCents!)).toBe(18000);
  });
  it("uses the planning rate only for the estimate, never for the actual", () => {
    const l = line(run([{ ...S1[0], planningFx: 1, customsFx: 20 }]), "S1", "A");
    expect(Z(l.customsValueCents!)).toBe(20000);
    expect(Z(l.planningValueCents!)).toBe(1000);
  });
  it("duty is the workbook's ZAR amount by default (source labelled)", () => {
    const l = line(run(S1), "S1", "A");
    expect(Z(l.dutyCents!)).toBe(500);
    expect(Z(l.dutyEstimatedCents!)).toBe(500);
    expect(l.dutySource).toBe("workbook duty amount");
  });
  it("duty can instead be a rate on the customs value (actual on customs value, estimate on planning value)", () => {
    expect(dutyOnCustomsValue(1900000, 10)).toBe(190000);
    const l = line(run(S1, { dutyRatePct: 10 }), "S1", "A");
    expect(Z(l.dutyCents!)).toBe(1900);
    expect(Z(l.dutyEstimatedCents!)).toBe(1800);
    expect(l.dutySource).toBe("rate on customs value");
  });
  it("rejects a nonsensical duty rate", () => {
    for (const r of [-1, 101, Number.NaN]) expect(() => run(S1, { dutyRatePct: r })).toThrow(/duty rate/i);
  });
});

describe("3 freight allocated by CBM share within each shipment only", () => {
  it("splits the shipment freight by CBM share", () => {
    const r = run(S1);
    expect(["A", "B", "C"].map((s) => Z(line(r, "S1", s).freightCents!))).toEqual([1500, 3000, 4500]);
    expect(line(r, "S1", "B").cbmShare).toBeCloseTo(2 / 6, 12);
  });
  it("allocated freight sums to the shipment freight to the cent, however awkward", () => {
    const r = run([
      { shipment: "S", sku: "A", cbm: 1, freight: 100 },
      { shipment: "S", sku: "B", cbm: 1, freight: 100 },
      { shipment: "S", sku: "C", cbm: 1, freight: 100 },
    ]);
    const parts = r.lines.map((l) => l.freightCents!);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(parts).toEqual([3334, 3333, 3333]);
    expect(r.shipments[0].freightAllocatedCents).toBe(r.shipments[0].freightTotalCents);
  });
  it("two shipments sharing a SKU never share freight allocations", () => {
    const r = run([
      { shipment: "S1", sku: "X", cbm: 1, freight: 9000 },
      { shipment: "S1", sku: "Y", cbm: 2, freight: 9000 },
      { shipment: "S2", sku: "X", cbm: 3, freight: 600 },
      { shipment: "S2", sku: "Z", cbm: 1, freight: 600 },
    ]);
    expect(Z(line(r, "S1", "X").freightCents!)).toBe(3000); // 1/3 of 9,000
    expect(Z(line(r, "S2", "X").freightCents!)).toBe(450); // 3/4 of 600
    // A global-by-SKU share would give 4/7 of 9,600 for X: it must not.
    expect(Z(line(r, "S1", "X").freightCents!) + Z(line(r, "S2", "X").freightCents!)).toBe(3450);
    expect(Z(r.shipments.find((s) => s.shipmentRef === "S1")!.freightAllocatedCents)).toBe(9000);
    expect(Z(r.shipments.find((s) => s.shipmentRef === "S2")!.freightAllocatedCents)).toBe(600);
    // The SKU view aggregates across shipments but does not re-allocate.
    expect(Z(r.skus.find((s) => s.sku === "X")!.freightCents)).toBe(3450);
  });
  it("a shipment's own freight is untouched by a different shipment's CBM", () => {
    const a = run([{ shipment: "S1", sku: "X", cbm: 1, freight: 900 }, { shipment: "S1", sku: "Y", cbm: 1, freight: 900 }]);
    const b = run([{ shipment: "S1", sku: "X", cbm: 1, freight: 900 }, { shipment: "S1", sku: "Y", cbm: 1, freight: 900 }, { shipment: "S2", sku: "X", cbm: 1000, freight: 5 }]);
    expect(Z(line(b, "S1", "X").freightCents!)).toBe(Z(line(a, "S1", "X").freightCents!));
  });
  it("zero total CBM in a shipment cannot be allocated: it is reported, not divided", () => {
    const r = run([{ shipment: "S", sku: "A", cbm: 0, freight: 100 }, { shipment: "S", sku: "B", cbm: 0, freight: 100 }]);
    expect(r.lines.every((l) => l.freightCents === null)).toBe(true);
    expect(r.shipments[0].warnings.join(" ")).toMatch(/cbm/i);
    expect(r.shipments[0].complete).toBe(false);
  });
  it("zero freight is a valid allocation of zero", () => {
    const r = run([{ shipment: "S", sku: "A", cbm: 1, freight: 0 }]);
    expect(line(r, "S", "A").freightCents).toBe(0);
  });
  it("rows of one shipment that disagree on the shipment freight are not allocated and are reported", () => {
    const r = run([{ shipment: "S", sku: "A", cbm: 1, freight: 100 }, { shipment: "S", sku: "B", cbm: 1, freight: 120 }]);
    expect(r.lines.every((l) => l.freightCents === null)).toBe(true);
    expect(r.shipments[0].warnings.join(" ")).toMatch(/disagree/i);
  });
  it("a missing shipment freight is not invented", () => {
    const r = run([{ shipment: "S", sku: "A", cbm: 1, freight: null }]);
    expect(line(r, "S", "A").freightCents).toBeNull();
    expect(line(r, "S", "A").missing).toContain("freightTotalZar");
  });
});

describe("4-5 landed cost, per unit, estimated versus actual", () => {
  const r = run(S1);
  it("landed (actual) = customs value + duty + allocated freight", () => {
    expect(Z(line(r, "S1", "A").landedActualCents!)).toBe(19000 + 500 + 1500);
    expect(Z(line(r, "S1", "B").landedActualCents!)).toBe(7600 + 200 + 3000);
    expect(Z(line(r, "S1", "C").landedActualCents!)).toBe(1900 + 50 + 4500);
  });
  it("landed per unit = total / quantity (shown to the cent)", () => {
    expect(line(r, "S1", "A").landedPerUnitActualCents).toBe(toCents(21000 / 100));
    expect(Z(line(r, "S1", "A").landedPerUnitActualCents!)).toBe(210);
    expect(line(run([{ ...S1[0], qty: 0 }]), "S1", "A").landedPerUnitActualCents).toBeNull();
  });
  it("estimated uses the planning FX; the difference is the FX variance", () => {
    const a = line(r, "S1", "A");
    expect(Z(a.landedEstimatedCents!)).toBe(18000 + 500 + 1500);
    expect(Z(a.fxVarianceCents!)).toBe(1000);
    expect(a.fxVarianceCents).toBe(a.landedActualCents! - a.landedEstimatedCents!);
    expect(Z(a.landedPerUnitEstimatedCents!)).toBe(200);
  });
  it("a favourable move (customs FX below planning) is a negative variance", () => {
    const a = line(run([{ ...S1[0], planningFx: 20, customsFx: 19 }]), "S1", "A");
    expect(Z(a.fxVarianceCents!)).toBe(-1000);
  });
  it("identifies the source of each rate", () => {
    const a = line(r, "S1", "A");
    expect(a.rateSources).toEqual({ planning: "LandedCost.planningFx", customs: "LandedCost.customsFx" });
    expect(r.rates.map((x) => [x.shipmentRef, x.planning, x.customs])).toEqual([["S1", [18], [19]]]);
  });
  it("without a planning FX the actual is still computed and the estimate is withheld", () => {
    const a = line(run([{ ...S1[0], planningFx: null }]), "S1", "A");
    expect(Z(a.landedActualCents!)).toBe(19000 + 500 + 9000); // a one-line shipment carries all of its R9,000 freight
    expect(a.landedEstimatedCents).toBeNull();
    expect(a.fxVarianceCents).toBeNull();
    expect(a.missing).toContain("planningFx");
    expect(a.status).toBe("complete"); // the actual is complete; the comparison is not
    expect(a.comparisonAvailable).toBe(false);
  });
});

describe("6 reconciliation: exact totals", () => {
  const r = run([...S1, { shipment: "S2", sku: "A", qty: 7, fobUsd: 333.33, planningFx: 18.1234, customsFx: 18.5555, duty: 77.77, cbm: 0.33, freight: 1234.56 }, { shipment: "S2", sku: "Q", qty: 3, fobUsd: 66.67, planningFx: 18.1234, customsFx: 18.5555, duty: 12.34, cbm: 0.67, freight: 1234.56 }]);
  it("lines sum to shipments and shipments to the grand total, to the cent", () => {
    for (const s of r.shipments) {
      const ls = r.lines.filter((l) => l.shipmentRef === s.shipmentRef);
      expect(s.totals!.landedActualCents).toBe(ls.reduce((a, l) => a + l.landedActualCents!, 0));
      expect(s.totals!.customsValueCents).toBe(ls.reduce((a, l) => a + l.customsValueCents!, 0));
      expect(s.totals!.dutyCents).toBe(ls.reduce((a, l) => a + l.dutyCents!, 0));
      expect(s.totals!.freightCents).toBe(ls.reduce((a, l) => a + l.freightCents!, 0));
      expect(s.totals!.fxVarianceCents).toBe(ls.reduce((a, l) => a + l.fxVarianceCents!, 0));
      expect(s.totals!.landedActualCents).toBe(s.totals!.customsValueCents + s.totals!.dutyCents + s.totals!.freightCents);
      expect(s.totals!.freightCents).toBe(s.freightTotalCents);
    }
    expect(r.totals.landedActualCents).toBe(r.shipments.reduce((a, s) => a + s.totals!.landedActualCents, 0));
    expect(r.totals.landedActualCents).toBe(r.totals.customsValueCents + r.totals.dutyCents + r.totals.freightCents);
    expect(r.totals.fxVarianceCents).toBe(r.totals.landedActualCents - r.totals.landedEstimatedCents!);
  });
  it("the SKU view totals equal the line totals", () => {
    expect(r.skus.reduce((a, s) => a + s.landedActualCents, 0)).toBe(r.totals.landedActualCents);
    expect(r.skus.reduce((a, s) => a + s.qty, 0)).toBe(r.lines.reduce((a, l) => a + l.qty, 0));
  });
  it("every reconciliation check passes on clean data, and each has an id and a label", () => {
    expect(r.checks.length).toBeGreaterThanOrEqual(5);
    expect(r.checks.every((c) => c.ok)).toBe(true);
    expect(new Set(r.checks.map((c) => c.id)).size).toBe(r.checks.length);
  });
  it("is deterministic and does not mutate its input", () => {
    const ds = landedDataset(S1);
    const before = JSON.stringify(ds);
    expect(JSON.stringify(runLandedCost(ds, {}))).toBe(JSON.stringify(runLandedCost(ds, {})));
    expect(JSON.stringify(ds)).toBe(before);
  });
});

describe("workbook's own freight allocation is reconciled, not trusted", () => {
  it("flags a difference from the engine's CBM allocation", () => {
    const r = run([
      { shipment: "S", sku: "A", cbm: 1, freight: 100, freightAllocated: 50 },
      { shipment: "S", sku: "B", cbm: 1, freight: 100, freightAllocated: 40 },
    ]);
    expect(line(r, "S", "A").freightDiffCents).toBe(0);
    expect(line(r, "S", "B").freightDiffCents).toBe(-1000);
    expect(r.shipments[0].warnings.join(" ")).toMatch(/workbook.*allocat/i);
    expect(r.checks.find((c) => c.id === "workbook-freight")!.ok).toBe(false);
  });
  it("is silent when the workbook has no allocation column data", () => {
    const r = run([{ shipment: "S", sku: "A", cbm: 1, freight: 100 }]);
    expect(line(r, "S", "A").freightDiffCents).toBeNull();
    expect(r.checks.find((c) => c.id === "workbook-freight")!.ok).toBe(true);
  });
});

describe("incomplete inputs are exposed, never invented", () => {
  it("a missing FOB leaves the line incomplete with no figures, and the shipment total withheld", () => {
    const r = run([{ ...S1[0], fobUsd: null }, S1[1], S1[2]]);
    const a = line(r, "S1", "A");
    expect(a.status).toBe("incomplete");
    expect(a.missing).toContain("fobUsd");
    expect(a.customsValueCents).toBeNull();
    expect(a.landedActualCents).toBeNull();
    const s = r.shipments[0];
    expect(s.complete).toBe(false);
    expect(s.totals).toBeNull();
    expect(s.partial.landedActualCents).toBe(line(r, "S1", "B").landedActualCents! + line(r, "S1", "C").landedActualCents!);
    expect(s.partial.lineCount).toBe(2);
    expect(r.totals.complete).toBe(false);
    expect(r.checks.find((c) => c.id === "complete")!.ok).toBe(false);
  });
  it("freight is still allocated across ALL lines of the shipment, so one missing FOB does not shift the others' freight", () => {
    const r = run([{ ...S1[0], fobUsd: null }, S1[1], S1[2]]);
    expect(Z(line(r, "S1", "B").freightCents!)).toBe(3000);
  });
  it("a missing customs FX or duty is named; zero is a valid value, not missing", () => {
    expect(line(run([{ ...S1[0], customsFx: null }]), "S1", "A").missing).toContain("customsFx");
    expect(line(run([{ ...S1[0], duty: null }]), "S1", "A").missing).toContain("dutyZar");
    const z = line(run([{ ...S1[0], duty: 0, fobUsd: 0 }]), "S1", "A");
    expect(z.status).toBe("complete");
    expect(z.landedActualCents).toBe(toCents(9000)); // no FOB value, no duty: only the shipment freight remains
  });
  it("a missing duty amount is not needed when a duty rate is supplied", () => {
    const a = line(run([{ ...S1[0], duty: null }], { dutyRatePct: 10 }), "S1", "A");
    expect(a.status).toBe("complete");
    expect(Z(a.dutyCents!)).toBe(1900);
  });
  it("an empty LandedCost tab yields an empty, honest result", () => {
    const r = run([]);
    expect(r.lines).toEqual([]);
    expect(r.shipments).toEqual([]);
    expect(r.totals.landedActualCents).toBe(0);
    expect(r.totals.complete).toBe(false);
  });
  it("states its assumptions: customs value = FOB at customs FX, duty column meaning, freight rule", () => {
    const r = run(S1);
    const ids = r.assumptions.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining(["customs-value", "duty-source", "freight-cbm", "fob-total"]));
  });
});

describe("review hardening", () => {
  it("zero freight over zero CBM is a valid allocation of zero", () => {
    const r = run([{ shipment: "S", sku: "A", cbm: 0, freight: 0 }, { shipment: "S", sku: "B", cbm: 0, freight: 0 }]);
    expect(r.lines.map((l) => l.freightCents)).toEqual([0, 0]);
    expect(r.shipments[0].complete).toBe(true);
  });
  it("a non-positive FX rate is treated as missing, not as a valid zero", () => {
    const a = line(run([{ ...S1[0], customsFx: 0 }]), "S1", "A");
    expect(a.status).toBe("incomplete");
    expect(a.missing).toContain("customsFx");
    expect(a.customsValueCents).toBeNull();
    const b = line(run([{ ...S1[0], planningFx: 0 }]), "S1", "A");
    expect(b.missing).toContain("planningFx");
    expect(b.landedEstimatedCents).toBeNull();
    expect(b.status).toBe("complete");
  });
  it("a zero-CBM line in a shipment with positive CBM gets zero freight and is flagged", () => {
    const r = run([{ shipment: "S", sku: "A", cbm: 0, freight: 100 }, { shipment: "S", sku: "B", cbm: 2, freight: 100 }]);
    expect(line(r, "S", "A").freightCents).toBe(0);
    expect(line(r, "S", "B").freightCents).toBe(10000);
    expect(r.shipments[0].warnings.join(" ")).toMatch(/zero cbm/i);
  });
});
