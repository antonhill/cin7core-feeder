import { describe, expect, it } from "vitest";
import { fromCents } from "@/rwtsa-demo/engine/money";
import { runFxExposure } from "@/rwtsa-demo/engine/fx-exposure";
import { landedDataset, type LineSpec, type PaySpec, type PoSpec2 } from "./landed-fixture";

const LINES: LineSpec[] = [{ shipment: "S1", sku: "A", planningFx: 18, customsFx: 19 }];
const PAYS: PaySpec[] = [
  { po: "PO-1", due: "2026-11-10", usd: 5000, fec: "FEC-1", locked: 18.1, zar: 90500 },
  { po: "PO-2", due: "2026-11-20", usd: 4000 },
  { po: "PO-3", due: "2026-12-05", usd: 2500.5, fec: "FEC-2", locked: 18.3, zar: 45759.15, deposit: true },
  { po: "PO-0", due: "2026-10-15", usd: 1000 },
];
const POS: PoSpec2[] = [{ po: "PO-1", shipment: "S1" }, { po: "PO-2", shipment: "S1" }, { po: "PO-3", shipment: null }];
const run = (pays = PAYS, cfg = {}, lines = LINES, pos = POS) => runFxExposure(landedDataset(lines, pays, pos), cfg);

describe("USD exposure by due date", () => {
  it("counts payments due on or after the as-at date as open exposure; earlier ones are listed separately (paid status unknown)", () => {
    const r = run();
    expect(r.asOf).toBe("2026-10-31");
    expect(fromCents(r.totals.openUsdCents)).toBe(5000 + 4000 + 2500.5);
    expect(fromCents(r.totals.dueBeforeAsAtUsdCents)).toBe(1000);
    expect(r.rows.find((x) => x.poNo === "PO-0")!.open).toBe(false);
    expect(r.warnings.join(" ")).toMatch(/before the as-at date/i);
  });
  it("a payment due exactly on the as-at date is open; one the day before is not", () => {
    const r = run([{ po: "P1", due: "2026-10-31", usd: 100 }, { po: "P2", due: "2026-10-30", usd: 50 }]);
    expect(r.rows.map((x) => [x.poNo, x.open])).toEqual([["P1", true], ["P2", false]]);
    expect(r.totals.openUsdCents).toBe(10000);
  });
  it("splits open exposure into covered by an FEC and uncovered", () => {
    const r = run();
    expect(fromCents(r.totals.coveredUsdCents)).toBe(5000 + 2500.5);
    expect(fromCents(r.totals.uncoveredUsdCents)).toBe(4000);
    expect(r.totals.coveredUsdCents + r.totals.uncoveredUsdCents).toBe(r.totals.openUsdCents);
  });
  it("an FEC reference without a locked rate is not cover", () => {
    const r = run([{ po: "P", due: "2026-11-10", usd: 100, fec: "F", locked: null }]);
    expect(r.totals.coveredUsdCents).toBe(0);
    expect(r.rows[0].covered).toBe(false);
  });
  it("buckets by month and by week from the as-at date, and the buckets sum to the open total exactly", () => {
    const m = run(PAYS, { bucket: "month" });
    expect(m.buckets.map((b) => [b.key, fromCents(b.usdCents)])).toEqual([["2026-11", 9000], ["2026-12", 2500.5]]);
    const w = run(PAYS, { bucket: "week" });
    expect(w.buckets.map((b) => b.key)).toEqual(["week 2", "week 3", "week 5"]); // 10 Nov is day 10 (week 2), 20 Nov day 20 (week 3), 5 Dec day 35 (week 5)
    for (const r of [m, w]) {
      expect(r.buckets.reduce((a, b) => a + b.usdCents, 0)).toBe(r.totals.openUsdCents);
      expect(r.buckets.reduce((a, b) => a + b.coveredUsdCents + b.uncoveredUsdCents, 0)).toBe(r.totals.openUsdCents);
    }
  });
  it("USD amounts are summed in whole cents (no floating-point drift)", () => {
    const r = run([{ po: "A", due: "2026-11-10", usd: 0.1 }, { po: "B", due: "2026-11-10", usd: 0.2 }, { po: "C", due: "2026-11-10", usd: 33.33 }]);
    expect(r.totals.openUsdCents).toBe(10 + 20 + 3333);
  });
  it("a different as-at date changes what is open", () => {
    expect(fromCents(run(PAYS, { asOf: "2026-11-15" }).totals.openUsdCents)).toBe(4000 + 2500.5);
    expect(() => run(PAYS, { asOf: "15/11/2026" })).toThrow(/as-at/i);
    expect(() => run(PAYS, { bucket: "day" as never })).toThrow(/bucket/i);
  });
  it("marks deposits", () => {
    expect(run().rows.find((x) => x.poNo === "PO-3")!.deposit).toBe(true);
  });
  it("an empty Payments_FEC tab gives an empty, honest result", () => {
    const r = run([]);
    expect(r.rows).toEqual([]);
    expect(r.totals.openUsdCents).toBe(0);
    expect(r.buckets).toEqual([]);
  });
});

describe("planning / FEC / customs FX comparison", () => {
  const r = run();
  const p1 = r.rows.find((x) => x.poNo === "PO-1")!;
  it("values the USD at each rate and names where each rate came from", () => {
    expect(fromCents(p1.zarAtFecCents!)).toBe(90500);
    expect(fromCents(p1.zarAtPlanningCents!)).toBe(90000);
    expect(fromCents(p1.zarAtCustomsCents!)).toBe(95000);
    expect(p1.rateSources).toEqual({ fec: "Payments_FEC.lockedRate", planning: "LandedCost.planningFx", customs: "LandedCost.customsFx" });
  });
  it("shows FEC against planning and against customs (positive = FEC costs more)", () => {
    expect(fromCents(p1.fecVsPlanningCents!)).toBe(500);
    expect(fromCents(p1.fecVsCustomsCents!)).toBe(-4500);
  });
  it("reconciles the workbook's own ZAR value with USD x locked rate", () => {
    expect(p1.zarReportedDiffCents).toBe(0);
    const bad = run([{ po: "PO-1", due: "2026-11-10", usd: 5000, fec: "F", locked: 18.1, zar: 90000 }], {}, LINES, POS).rows[0];
    expect(fromCents(bad.zarReportedDiffCents!)).toBe(-500); // reported - computed
    expect(run([{ po: "PO-1", due: "2026-11-10", usd: 5000, fec: "F", locked: 18.1, zar: 90000 }]).warnings.join(" ")).toMatch(/ZAR value.*differs/i);
  });
  it("does not guess a rate when the PO has no shipment, or sits in several, or the shipment's rate varies", () => {
    const p3 = r.rows.find((x) => x.poNo === "PO-3")!;
    expect(p3.zarAtPlanningCents).toBeNull();
    expect(p3.shipmentRef).toBeNull();
    expect(p3.rateNote).toMatch(/shipment/i);
    const multi = run([{ po: "PO-1", due: "2026-11-10", usd: 100 }], {}, [{ shipment: "S1", sku: "A" }, { shipment: "S2", sku: "B", planningFx: 17 }], [{ po: "PO-1", shipment: "S1" }, { po: "PO-1", shipment: "S2" }]);
    expect(multi.rows[0].zarAtPlanningCents).toBeNull();
    expect(multi.rows[0].rateNote).toMatch(/more than one shipment/i);
    const varying = run([{ po: "PO-1", due: "2026-11-10", usd: 100 }], {}, [{ shipment: "S1", sku: "A", planningFx: 18 }, { shipment: "S1", sku: "B", planningFx: 18.5 }], [{ po: "PO-1", shipment: "S1" }]);
    expect(varying.rows[0].zarAtPlanningCents).toBeNull();
    expect(varying.rows[0].rateNote).toMatch(/more than one/i);
  });
  it("withholds the FEC comparison when there is no locked rate", () => {
    const p2 = r.rows.find((x) => x.poNo === "PO-2")!;
    expect(p2.zarAtFecCents).toBeNull();
    expect(p2.fecVsPlanningCents).toBeNull();
    expect(fromCents(p2.zarAtPlanningCents!)).toBe(72000); // planning is still shown
  });
});

describe("review hardening", () => {
  it("a locked rate without an FEC reference is not cover, and no FEC value is shown for it", () => {
    const r = run([{ po: "PO-1", due: "2026-11-10", usd: 5000, fec: null, locked: 18.1 }]);
    expect(r.rows[0].covered).toBe(false);
    expect(r.rows[0].zarAtFecCents).toBeNull();
    expect(r.rows[0].fecVsPlanningCents).toBeNull();
    expect(r.warnings.join(" ")).toMatch(/locked rate but no FEC reference/i);
  });
  it("a shipment line with no planning rate withholds the planning comparison rather than using the other lines' rate", () => {
    const r = run([{ po: "PO-1", due: "2026-11-10", usd: 100 }], {}, [{ shipment: "S1", sku: "A", planningFx: 18 }, { shipment: "S1", sku: "B", planningFx: null }], [{ po: "PO-1", shipment: "S1" }]);
    expect(r.rows[0].zarAtPlanningCents).toBeNull();
    expect(r.rows[0].rateNote).toMatch(/no planning or customs rate/i);
  });
  it("buckets order correctly across the year boundary", () => {
    const r = run([{ po: "A", due: "2027-01-05", usd: 1 }, { po: "B", due: "2026-12-20", usd: 1 }, { po: "C", due: "2026-11-02", usd: 1 }]);
    expect(r.buckets.map((b) => b.key)).toEqual(["2026-11", "2026-12", "2027-01"]);
    expect(run([{ po: "A", due: "2027-01-05", usd: 1 }, { po: "B", due: "2026-12-20", usd: 1 }], { bucket: "week" }).buckets.map((b) => b.key)).toEqual(["week 8", "week 10"]);
  });
});
