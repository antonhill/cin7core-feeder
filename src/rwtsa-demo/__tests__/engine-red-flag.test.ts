import { describe, expect, it } from "vitest";
import { availableOf } from "@/rwtsa-demo/engine/stock";
import { median, detectAnomalies } from "@/rwtsa-demo/engine/anomaly";
import { allocateUnits, classifyPoStatus } from "@/rwtsa-demo/engine/inbound";
import { weekOfDate } from "@/rwtsa-demo/engine/calendar";
import { DEFAULT_RED_FLAG_CONFIG, WEEKS_PER_MONTH, runRedFlag, type RedFlagResult, type SkuResult } from "@/rwtsa-demo/engine";
import { makeDataset, type PoSpec, type SkuSpec } from "./engine-fixture";

const W = (monthly: number) => monthly / 4.345;
const flat = (n: number, len = 6) => Array.from({ length: len }, () => n);
const base = (over: Partial<SkuSpec> = {}): SkuSpec => ({ sku: "S1", jhb: 85, committed: 15, sales: flat(40), ...over }); // Available 70
const sku = (r: RedFlagResult, id = "S1"): SkuResult => {
  const s = r.skus.find((x) => x.sku === id);
  if (!s) throw new Error("no sku " + id);
  return s;
};
const run = (skus: SkuSpec[], pos: PoSpec[] = [], cfg = {}, ex: { sku: string; month: string; reason: string }[] = [], months?: string[]) =>
  runRedFlag(makeDataset({ skus, pos, months }), cfg, ex);

describe("1-3 Available stock", () => {
  it("1. Available = JHB + Durban + Cape Town + Factory Store - Committed, per SKU", () => {
    expect(availableOf({ jhb: 50, durban: 20, capeTown: 10, factoryStore: 5, committed: 15 })).toBe(70);
    const r = run([base({ jhb: 50, durban: 20, capeTown: 10, factory: 5, committed: 15 })]);
    expect(sku(r).available).toBe(70);
  });
  it("2. Bond is excluded from opening Available", () => {
    expect(sku(run([base({ bond: 999 })])).available).toBe(70);
  });
  it("3. In transit is excluded from opening Available", () => {
    expect(sku(run([base({ inTransit: 999 })])).available).toBe(70);
  });
  it("reconciles against the workbook's reported Available and exposes a mismatch", () => {
    const ok = run([base()]);
    expect(sku(ok).availableDifference).toBe(0);
    expect(ok.summary.availableMismatchSkus).toBe(0);
    const bad = run([base({ reportedAvailable: 75 })]);
    expect(sku(bad).availableDifference).toBe(-5); // computed 70 - reported 75
    expect(bad.summary.availableMismatchSkus).toBe(1);
    expect(sku(bad).available).toBe(70); // the engine uses the brief's formula, not the file's number
    expect(sku(run([base({ reportedAvailable: null })])).availableDifference).toBeNull();
  });
  it("can be negative (over-committed) and is not clamped", () => {
    expect(sku(run([base({ jhb: 5, committed: 15 })])).available).toBe(-10);
  });
});

describe("4 No double deduction of commitments", () => {
  it("projection starts at Available and committed_due is zero by default", () => {
    const r = run([base({ sales: flat(0) })]);
    const s = sku(r);
    expect(s.balances).toHaveLength(13);
    expect(s.balances.every((b) => b === 70)).toBe(true); // 70 already net of the 15 committed; never 55
  });
  it("a separate dated commitment schedule is deducted only in its own week", () => {
    const r = runRedFlag(makeDataset({ skus: [base({ sales: flat(0) })] }), { committedDue: { S1: { 3: 20 } } }, []);
    const b = sku(r).balances;
    expect(b[0]).toBe(70);
    expect(b[1]).toBe(70);
    expect(b[2]).toBe(50);
    expect(b[12]).toBe(50);
  });
});

describe("5-7 Forecast and anchoring to the stock date", () => {
  it("5. six-month average, weekly = monthly / 4.345", () => {
    expect(WEEKS_PER_MONTH).toBe(4.345);
    const s = sku(run([base({ sales: [10, 20, 30, 40, 50, 60] })]));
    expect(s.forecast.status).toBe("ok");
    expect(s.monthlyForecast).toBe(35);
    expect(s.weeklyForecast).toBeCloseTo(35 / 4.345, 10);
  });
  it("the forecast window is configurable", () => {
    const s = sku(run([base({ sales: [10, 20, 30, 40, 50, 60] })], [], { forecastWindowMonths: 3 }));
    expect(s.monthlyForecast).toBe(50); // 40,50,60
  });
  it("6. anchored to the stock date: strict mode wants the six months ending October 2026 and does not substitute older months", () => {
    const r = run([base()], [], { historyAnchor: "strict" });
    expect(r.window.months).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(r.window.missingMonths).toEqual(["2026-09", "2026-10"]);
    const s = sku(r);
    expect(s.forecast.status).toBe("insufficient");
    expect(s.monthlyForecast).toBeNull();
    expect(s.weeklyForecast).toBeNull();
    expect(r.limitations.join(" ")).toMatch(/2026-09/);
  });
  it("6. strict mode forecasts normally when history reaches the stock month", () => {
    const months = ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"];
    const r = run([base({ sales: [10, 10, 10, 10, 40, 40] })], [], { historyAnchor: "strict" }, [], months);
    expect(sku(r).monthlyForecast).toBe(20);
    expect(r.window.missingMonths).toEqual([]);
  });
  it("6. a stock date that is not a month end anchors to the previous complete month", () => {
    const r = run([base()], [], { historyAnchor: "strict", stockDate: "2026-10-15" });
    expect(r.window.months[5]).toBe("2026-09");
  });
  it("last-available mode makes the intervening months a visible assumption and invents no sales", () => {
    const r = run([base({ sales: [10, 10, 10, 40, 40, 40] })]);
    expect(r.window.anchor).toBe("last-available");
    expect(r.window.months).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(r.window.lastHistoryMonth).toBe("2026-08");
    expect(r.window.stockMonth).toBe("2026-10");
    expect(r.window.gapMonths).toEqual(["2026-09", "2026-10"]);
    expect(r.assumptions.map((a) => a.id)).toContain("history-gap");
    expect(sku(r).monthlyForecast).toBe(25); // average of the six months actually present; nothing added for Sep/Oct
  });
  it("7. a blank cell inside the window is a missing observation: no forecast, with a limitation", () => {
    const s = sku(run([base({ sales: [40, 40, null, 40, 40, 40] })]));
    expect(s.forecast).toEqual({ status: "insufficient", missingMonths: ["2026-05"] });
    expect(s.monthlyForecast).toBeNull();
    expect(s.limitation).toMatch(/missing/i);
  });
  it("7. a SKU with no history rows at all has no forecast", () => {
    const ds = makeDataset({ skus: [base()] });
    const s = runRedFlag({ ...ds, tables: { ...ds.tables, salesHistory: [] } }, {}, []);
    expect(sku(s).forecast.status).toBe("insufficient");
  });
  it("an explicit zero is a valid observation, not a missing one", () => {
    const s = sku(run([base({ sales: [0, 0, 0, 0, 0, 60] })]));
    expect(s.monthlyForecast).toBe(10);
  });
});

describe("8-10 Projection, breach, shortfall, proposed order", () => {
  const s = () => sku(run([base()])); // Available 70, forecast 40/month, min 10
  it("balance(w) = balance(w-1) + inbound(w) - forecast(w)", () => {
    const b = s().balances;
    expect(b[0]).toBeCloseTo(70 - W(40), 9);
    expect(b[1]).toBeCloseTo(70 - 2 * W(40), 9);
    expect(b[12]).toBeCloseTo(70 - 13 * W(40), 9);
  });
  it("8. first breach is the first week the closing balance is below the minimum", () => {
    expect(s().firstBreachWeek).toBe(7); // week 6: 14.78 >= 10; week 7: 5.56 < 10
    expect(s().balances[5]).toBeGreaterThanOrEqual(10);
    expect(s().balances[6]).toBeLessThan(10);
  });
  it("a balance exactly at the minimum is not a breach", () => {
    const r = sku(run([base({ jhb: 10, committed: 0, sales: flat(0) })]));
    expect(r.firstBreachWeek).toBeNull();
  });
  it("9. shortfall is the maximum projected shortfall against the minimum across the horizon", () => {
    expect(s().shortfall).toBeCloseTo(10 - (70 - 13 * W(40)), 9);
  });
  it("9. shortfall uses the maximum, not the final week, when inbound recovers the balance", () => {
    const r = sku(run([base()], [{ poNo: "P1", sku: "S1", qty: 500, etaStores: "2026-12-20", status: "On order" }]));
    // arrives week 8 (50 days -> ceil(50/7) = 8); the worst week is week 7
    const worst = 10 - (70 - 7 * W(40));
    expect(r.shortfall).toBeCloseTo(worst, 9);
    expect(r.balances[12]).toBeGreaterThan(10);
  });
  it("10. proposed order is the shortfall rounded up to whole units, never below zero", () => {
    expect(s().proposedOrder).toBe(Math.ceil(10 - (70 - 13 * W(40))));
    const ok = sku(run([base({ jhb: 1000, committed: 0 })]));
    expect(ok.shortfall).toBe(0);
    expect(ok.proposedOrder).toBe(0);
    expect(ok.firstBreachWeek).toBeNull();
  });
  it("10. proposed quantity is labelled as a proposal, not a purchase order", () => {
    const r = run([base()]);
    expect(r.labels.proposedOrder).toMatch(/proposed/i);
    expect(r.labels.proposedOrder).toMatch(/not an authori[sz]ed purchase order/i);
  });
  it("a SKU with no minimum level is not evaluated, with a limitation", () => {
    const r = sku(run([base({ minLevel: null })]));
    expect(r.firstBreachWeek).toBeNull();
    expect(r.proposedOrder).toBe(0);
    expect(r.limitation).toMatch(/minimum/i);
    expect(r.evaluable).toBe(false);
  });
});

describe("11-14 Incoming purchase orders", () => {
  it("11. receipts land in the week of ETA-to-stores (not ETA-to-port)", () => {
    expect(weekOfDate("2026-10-31", "2026-11-01")).toBe(1);
    expect(weekOfDate("2026-10-31", "2026-11-07")).toBe(1);
    expect(weekOfDate("2026-10-31", "2026-11-08")).toBe(2);
    expect(weekOfDate("2026-10-31", "2026-11-15")).toBe(3);
    const s = sku(run([base({ sales: flat(0) })], [{ poNo: "P1", sku: "S1", qty: 100, etaStores: "2026-11-15", status: "On order" }]));
    expect(s.inboundWeeks[2]).toBe(100);
    expect(s.inboundWeeks.reduce((a, b) => a + b, 0)).toBe(100);
    expect(s.balances[1]).toBe(70);
    expect(s.balances[2]).toBe(170);
  });
  it("receipts beyond the horizon are not counted as inbound within the horizon", () => {
    const r = run([base({ sales: flat(0) })], [{ poNo: "P1", sku: "S1", qty: 100, etaStores: "2027-06-01", status: "On order" }]);
    expect(sku(r).inboundTotal).toBe(0);
    expect(r.inbound.beyondHorizonUnits).toBe(100);
  });
  it("on-water and on-order are separated", () => {
    const r = run(
      [base({ sales: flat(0) })],
      [
        { poNo: "P1", sku: "S1", qty: 10, etaStores: "2026-11-15", status: "On the water" },
        { poNo: "P2", sku: "S1", qty: 20, etaStores: "2026-11-16", status: "On order" },
      ]
    );
    expect(r.inbound.onWaterUnits).toBe(10);
    expect(r.inbound.onOrderUnits).toBe(20);
    expect(sku(r).inboundTotal).toBe(30);
  });
  it("12. an overdue shipment still on the water is assumed to arrive in week 1 (visible, configurable)", () => {
    const po = [{ poNo: "P1", sku: "S1", qty: 100, etaStores: "2026-10-10", status: "On the water" }];
    const r = run([base({ sales: flat(0) })], po);
    expect(sku(r).inboundWeeks[0]).toBe(100);
    expect(r.inbound.overdueAssumedWeek1Units).toBe(100);
    expect(r.assumptions.map((a) => a.id)).toContain("overdue-on-water");
    const off = run([base({ sales: flat(0) })], po, { overdueOnWater: "exclude" });
    expect(sku(off).inboundTotal).toBe(0);
    expect(off.inbound.overdueExcludedUnits).toBe(100);
  });
  it("12. an overdue shipment that is only on order is not assumed to arrive; it is exposed", () => {
    const r = run([base({ sales: flat(0) })], [{ poNo: "P1", sku: "S1", qty: 100, etaStores: "2026-10-10", status: "On order" }]);
    expect(sku(r).inboundTotal).toBe(0);
    expect(r.inbound.overdueOnOrderUnits).toBe(100);
  });
  it("received / closed lines and unclassified statuses are not counted as inbound, and are exposed", () => {
    const r = run(
      [base({ sales: flat(0) })],
      [
        { poNo: "P1", sku: "S1", qty: 7, etaStores: "2026-11-15", status: "Received" },
        { poNo: "P2", sku: "S1", qty: 9, etaStores: "2026-11-15", status: "???" },
      ]
    );
    expect(sku(r).inboundTotal).toBe(0);
    expect(r.inbound.receivedExcludedUnits).toBe(7);
    expect(r.inbound.unclassifiedUnits).toBe(9);
  });
  it("13. inbound is not double-counted with Stock in-transit: the projection uses purchase orders only", () => {
    const r = run([base({ sales: flat(0), inTransit: 30 })], [{ poNo: "P1", sku: "S1", qty: 30, etaStores: "2026-11-15", status: "On the water" }]);
    expect(sku(r).balances[12]).toBe(100); // 70 + 30 once, never 130
    expect(sku(r).inboundTotal).toBe(30); // purchase orders only; Stock in-transit is never added to the inbound figure
    expect(r.inbound.reconciliation.skusConsistent).toBe(1);
    expect(r.inbound.reconciliation.skusMismatched).toBe(0);
  });
  it("13. when Stock in-transit and on-water POs disagree, the two buckets stay separate and the uncertainty is exposed", () => {
    const r = run([base({ sales: flat(0), inTransit: 50 })], [{ poNo: "P1", sku: "S1", qty: 30, etaStores: "2026-11-15", status: "On the water" }]);
    expect(sku(r).balances[12]).toBe(100); // still PO only; nothing invented
    expect(sku(r).inboundTotal).toBe(30);
    expect(r.inbound.reconciliation).toMatchObject({ skusMismatched: 1, inTransitStockUnits: 50, onWaterPoUnits: 30 });
    expect(r.limitations.join(" ")).toMatch(/in.transit/i);
  });
  it("14. a style-level PO is split to SKUs by the supplied size curve, exactly", () => {
    const skus = [
      { sku: "A-S", size: "S", sales: flat(0) },
      { sku: "A-M", size: "M", sales: flat(0) },
      { sku: "A-L", size: "L", sales: flat(0) },
    ] as SkuSpec[];
    const r = run(skus, [{ poNo: "P1", style: "ST", qty: 100, etaStores: "2026-11-15", status: "On order" }], { sizeCurve: { kind: "explicit", weights: { S: 1, M: 2, L: 1 } } });
    expect([sku(r, "A-S"), sku(r, "A-M"), sku(r, "A-L")].map((x) => x.inboundTotal)).toEqual([25, 50, 25]);
    const odd = run(skus, [{ poNo: "P1", style: "ST", qty: 101, etaStores: "2026-11-15", status: "On order" }], { sizeCurve: { kind: "explicit", weights: { S: 1, M: 1, L: 1 } } });
    const parts = odd.skus.map((x) => x.inboundTotal);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(101);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
  });
  it("14. allocateUnits is exact, deterministic and handles zero weights", () => {
    expect(allocateUnits(10, [["a", 1], ["b", 1], ["c", 1]])).toEqual([["a", 4], ["b", 3], ["c", 3]]);
    expect(allocateUnits(10, [["a", 0], ["b", 0]])).toBeNull();
    expect(allocateUnits(0, [["a", 1]])).toEqual([["a", 0]]);
    expect(allocateUnits(5, [["a", 1], ["b", 0]])).toEqual([["a", 5], ["b", 0]]);
  });
  it("14. with no size curve a style-level PO is held unallocated and exposed, never guessed", () => {
    const skus = [{ sku: "A-S", size: "S", sales: flat(10) }, { sku: "A-M", size: "M", sales: flat(30) }] as SkuSpec[];
    const pos = [{ poNo: "P1", style: "ST", qty: 100, etaStores: "2026-11-15", status: "On order" }];
    const none = run(skus, pos, { sizeCurve: { kind: "none" } });
    expect(none.skus.every((x) => x.inboundTotal === 0)).toBe(true);
    expect(none.inbound.unallocatedStyleUnits).toBe(100);
    expect(none.limitations.join(" ")).toMatch(/size curve/i);
    const prop = run(skus, pos, { sizeCurve: { kind: "demand-proportional" } });
    expect(sku(prop, "A-S").inboundTotal).toBe(25);
    expect(sku(prop, "A-M").inboundTotal).toBe(75);
    expect(prop.assumptions.map((a) => a.id)).toContain("size-curve-demand");
  });
  it("a PO naming an unknown SKU is exposed, not dropped silently", () => {
    const r = run([base()], [{ poNo: "P1", sku: "NOPE", qty: 5, etaStores: "2026-11-15", status: "On order" }]);
    expect(r.inbound.unmatchedUnits).toBe(5);
  });
});

describe("15-19 Anomalies and planner exclusions", () => {
  it("15. median of an odd and an even count; blanks are ignored", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([10, 20, 30, 40])).toBe(25);
    expect(median([])).toBeNull();
    const series = [10, 12, null, 11, 400].map((qty, i) => ({ month: `2026-0${i + 1}`, qty }));
    const r = detectAnomalies(series, { multiple: 5, floor: 40 });
    expect(r.median).toBe(11.5);
    expect(r.flagged.map((f) => f.month)).toEqual(["2026-05"]);
  });
  it("16. thresholds are configurable and 'exceeds' is strict on both", () => {
    const series = (q: number) => [20, 20, 20, 20, 20, q].map((qty, i) => ({ month: `2026-0${i + 1}`, qty }));
    expect(detectAnomalies(series(101), { multiple: 5, floor: 40 }).flagged).toHaveLength(1);
    expect(detectAnomalies(series(100), { multiple: 5, floor: 40 }).flagged).toHaveLength(0); // exactly 5x median
    expect(detectAnomalies(series(101), { multiple: 6, floor: 40 }).flagged).toHaveLength(0);
    expect(detectAnomalies(series(101), { multiple: 5, floor: 101 }).flagged).toHaveLength(0); // equal to the floor
    expect(detectAnomalies(series(101), { multiple: 5, floor: 100 }).flagged).toHaveLength(1);
    const small = [2, 2, 2, 2, 2, 30].map((qty, i) => ({ month: `2026-0${i + 1}`, qty }));
    expect(detectAnomalies(small, { multiple: 5, floor: 40 }).flagged).toHaveLength(0); // 15x median but under the 40 floor
  });
  const spike = [40, 40, 40, 40, 40, 400];
  it("detection is reported for the SKU, with the window it falls in", () => {
    const r = run([base({ sales: spike })]);
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0]).toMatchObject({ sku: "S1", month: "2026-08", qty: 400, median: 40, inWindow: true, excluded: false, reason: null });
    expect(r.summary.anomaliesToReview).toBe(1);
    expect(sku(r).monthlyForecast).toBe(100); // (200 + 400) / 6
  });
  it("17. an exclusion needs a non-empty reason", () => {
    for (const reason of ["", "   ", "\n\t"]) {
      expect(() => run([base({ sales: spike })], [], {}, [{ sku: "S1", month: "2026-08", reason }])).toThrow(/reason/i);
    }
    expect(() => run([base({ sales: spike })], [], {}, [{ sku: "NOPE", month: "2026-08", reason: "x" }])).toThrow(/unknown/i);
  });
  it("18. an excluded month leaves BOTH the demand total and the observation count; the forecast is recalculated", () => {
    const r = run([base({ sales: spike })], [], {}, [{ sku: "S1", month: "2026-08", reason: "One-off tender" }]);
    const s = sku(r);
    expect(s.forecast).toMatchObject({ status: "ok", total: 200, count: 5 });
    expect(s.monthlyForecast).toBe(40); // not 200/6 = 33.3 (count must drop) and not (200+0)/6
    expect(r.anomalies[0]).toMatchObject({ excluded: true, reason: "One-off tender" });
    expect(r.summary.anomaliesToReview).toBe(0);
    expect(r.summary.anomaliesExcluded).toBe(1);
  });
  it("18. no median substitution: the excluded value is not replaced by anything", () => {
    const s = sku(run([base({ sales: [10, 20, 30, 40, 50, 900] })], [], {}, [{ sku: "S1", month: "2026-08", reason: "x" }]));
    expect(s.monthlyForecast).toBe(30); // (10+20+30+40+50)/5
  });
  it("18. reversal restores the original forecast", () => {
    const withEx = sku(run([base({ sales: spike })], [], {}, [{ sku: "S1", month: "2026-08", reason: "r" }]));
    const reversed = sku(run([base({ sales: spike })], [], {}, []));
    expect(withEx.monthlyForecast).toBe(40);
    expect(reversed.monthlyForecast).toBe(100);
  });
  it("an exclusion outside the forecast window does not change the forecast", () => {
    const months = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
    const s = [400, 40, 40, 40, 40, 40, 40, 40];
    const a = sku(run([base({ sales: s })], [], {}, [], months));
    const b = sku(run([base({ sales: s })], [], {}, [{ sku: "S1", month: "2026-01", reason: "r" }], months));
    expect(a.monthlyForecast).toBe(b.monthlyForecast);
  });
  it("excluding every month in the window leaves no forecast", () => {
    const ex = MONTHS.map((month) => ({ sku: "S1", month, reason: "r" }));
    expect(sku(run([base()], [], {}, ex)).forecast.status).toBe("insufficient");
  });
  it("19. the planted tender spike causes a FALSE stock-out that the exclusion removes", () => {
    const stockRich = base({ jhb: 215, committed: 15, sales: spike }); // Available 200
    const before = sku(run([stockRich]));
    expect(before.firstBreachWeek).toBe(9);
    expect(before.proposedOrder).toBeGreaterThan(0);
    const after = sku(run([stockRich], [], {}, [{ sku: "S1", month: "2026-08", reason: "One-off tender order" }]));
    expect(after.firstBreachWeek).toBeNull();
    expect(after.shortfall).toBe(0);
    expect(after.proposedOrder).toBe(0);
    const r = run([stockRich], [], {}, [{ sku: "S1", month: "2026-08", reason: "One-off tender order" }]);
    expect(r.summary.shortageSkus).toBe(0);
  });
});
const MONTHS = ["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

describe("20 Tender products", () => {
  const tender = base({ sku: "T1", tender: true, minLevel: null, jhb: 0, committed: 0, sales: flat(40) });
  it("has no replenishment requirement and is labelled as excluded from automatic ordering", () => {
    const r = run([tender, base()]);
    const t = sku(r, "T1");
    expect(t.tenderExempt).toBe(true);
    expect(t.proposedOrder).toBe(0);
    expect(t.firstBreachWeek).toBeNull();
    expect(t.shortfall).toBe(0);
    expect(t.limitation).toBeNull(); // missing min level is expected for a tender SKU, not a data gap
    expect(r.summary.tenderExemptSkus).toBe(1);
    expect(r.summary.shortageSkus).toBe(1); // only S1
    expect(r.labels.tenderExempt).toMatch(/excluded from automatic ordering/i);
  });
  it("still shows demand, stock and forecast", () => {
    const t = sku(run([tender]), "T1");
    expect(t.monthlyForecast).toBe(40);
    expect(t.available).toBe(0);
    expect(t.balances).toHaveLength(13);
  });
  it("a tender SKU with a minimum level set still never proposes an order", () => {
    const t = sku(run([{ ...tender, minLevel: 50 }]), "T1");
    expect(t.proposedOrder).toBe(0);
    expect(t.shortfall).toBe(0);
    expect(t.firstBreachWeek).toBeNull();
  });
  it("an unknown tender flag (blank) is not treated as tender", () => {
    const t = sku(run([base({ tender: null })]));
    expect(t.tenderExempt).toBe(false);
  });
});

describe("21-22 Roll-up and months of cover", () => {
  const skus = [
    base({ sku: "A-S", size: "S", jhb: 30, committed: 0, sales: flat(40), minLevel: 10 }),
    base({ sku: "A-M", size: "M", jhb: 200, committed: 0, sales: flat(10), minLevel: 5 }),
    base({ sku: "A-L", size: "L", jhb: 0, committed: 0, sales: flat(60), minLevel: 20 }),
    base({ sku: "B-M", style: "ST2", size: "M", jhb: 100, committed: 0, sales: flat(20), minLevel: 10 }),
  ];
  const pos = [{ poNo: "P1", sku: "A-S", qty: 25, etaStores: "2026-11-20", status: "On order" }];
  it("21. style quantities reconcile exactly to the underlying SKU quantities", () => {
    const r = run(skus, pos);
    for (const st of r.styles) {
      const members = r.skus.filter((s) => s.styleCode === st.styleCode);
      const sum = (f: (s: SkuResult) => number) => members.reduce((a, s) => a + f(s), 0);
      expect(st.skuCount).toBe(members.length);
      expect(st.available).toBe(sum((s) => s.available ?? 0));
      expect(st.inboundTotal).toBe(sum((s) => s.inboundTotal));
      expect(st.weeklyForecast).toBeCloseTo(sum((s) => s.weeklyForecast ?? 0), 9);
      expect(st.shortfall).toBeCloseTo(sum((s) => s.shortfall), 9);
      expect(st.proposedOrder).toBe(sum((s) => s.proposedOrder));
      expect(st.balances).toHaveLength(13);
      for (let w = 0; w < 13; w++) expect(st.balances[w]).toBeCloseTo(sum((s) => s.balances[w]), 9);
    }
    expect(r.summary.totalProposedOrder).toBe(r.skus.reduce((a, s) => a + s.proposedOrder, 0));
    expect(r.styles.reduce((a, s) => a + s.proposedOrder, 0)).toBe(r.summary.totalProposedOrder);
  });
  it("21. a style's first breach is the earliest SKU breach (sizes are not netted against each other)", () => {
    const r = run(skus, pos);
    const a = r.styles.find((s) => s.styleCode === "ST")!;
    const earliest = Math.min(...r.skus.filter((s) => s.styleCode === "ST" && s.firstBreachWeek !== null).map((s) => s.firstBreachWeek!));
    expect(a.firstBreachWeek).toBe(earliest);
    expect(a.shortageSkus).toBe(r.skus.filter((s) => s.styleCode === "ST" && s.shortfall > 0).length);
  });
  it("22. months of cover = Available / monthly forecast", () => {
    expect(sku(run([base()])).monthsOfCover).toBeCloseTo(70 / 40, 9);
    expect(sku(run([base({ jhb: 0, committed: 0 })])).monthsOfCover).toBe(0);
    expect(sku(run([base({ jhb: 5, committed: 15 })])).monthsOfCover).toBe(0); // negative Available: no negative cover
  });
  it("22. style months of cover is recomputed from totals, not summed or averaged", () => {
    const r = run(skus, pos);
    const st = r.styles.find((s) => s.styleCode === "ST")!;
    const members = r.skus.filter((s) => s.styleCode === "ST");
    const num = members.reduce((a, s) => a + (s.available ?? 0), 0);
    const den = members.reduce((a, s) => a + (s.monthlyForecast ?? 0), 0);
    expect(st.monthsOfCover).toBeCloseTo(num / den, 9);
    const naiveAverage = members.reduce((a, s) => a + (s.monthsOfCover ?? 0), 0) / members.length;
    expect(Math.abs(st.monthsOfCover! - naiveAverage)).toBeGreaterThan(0.01); // the fixture distinguishes the two
    const naiveSum = members.reduce((a, s) => a + (s.monthsOfCover ?? 0), 0);
    expect(Math.abs(st.monthsOfCover! - naiveSum)).toBeGreaterThan(0.01);
  });
  it("22. SKUs without a forecast are left out of BOTH the numerator and the denominator, and counted", () => {
    const withGap = [...skus.slice(0, 2), base({ sku: "A-L", size: "L", jhb: 999, committed: 0, sales: [null, 1, 1, 1, 1, 1] })];
    const r = run(withGap, []);
    const st = r.styles.find((s) => s.styleCode === "ST")!;
    expect(st.skusWithoutForecast).toBe(1);
    expect(st.monthsOfCover).toBeCloseTo((30 + 200) / (40 + 10), 9);
  });
});

describe("23-24 Edge cases and horizon", () => {
  it("23. zero demand: no consumption, months of cover is n/a, no breach if at or above minimum", () => {
    const s = sku(run([base({ sales: flat(0) })]));
    expect(s.weeklyForecast).toBe(0);
    expect(s.monthsOfCover).toBeNull();
    expect(s.firstBreachWeek).toBeNull();
  });
  it("23. zero demand with Available already below the minimum breaches in week 1", () => {
    const s = sku(run([base({ sales: flat(0), jhb: 4, committed: 0 })]));
    expect(s.firstBreachWeek).toBe(1);
    expect(s.proposedOrder).toBe(6);
  });
  it("23. an empty dataset and a SKU with no stock row do not throw", () => {
    const ds = makeDataset({ skus: [] });
    const r = runRedFlag(ds, {}, []);
    expect(r.skus).toEqual([]);
    expect(r.summary.shortageSkus).toBe(0);
    const ds2 = makeDataset({ skus: [base()] });
    const r2 = runRedFlag({ ...ds2, tables: { ...ds2.tables, stock: [] } }, {}, []);
    expect(sku(r2).available).toBeNull();
    expect(sku(r2).limitation).toMatch(/stock/i);
  });
  it("24. horizon is 13 or 26 weeks and nothing else", () => {
    expect(sku(run([base()], [], { horizonWeeks: 13 })).balances).toHaveLength(13);
    expect(sku(run([base()], [], { horizonWeeks: 26 })).balances).toHaveLength(26);
    for (const h of [0, 12, 14, 25, 27, 52, 13.5, Number.NaN]) expect(() => run([base()], [], { horizonWeeks: h as never })).toThrow(/horizon/i);
  });
  it("24. a longer horizon can only increase the maximum shortfall", () => {
    const a = sku(run([base()], [], { horizonWeeks: 13 }));
    const b = sku(run([base()], [], { horizonWeeks: 26 }));
    expect(b.shortfall).toBeGreaterThanOrEqual(a.shortfall);
    expect(b.firstBreachWeek).toBe(a.firstBreachWeek);
  });
  it("24. the forecast window is 1 to 36 months", () => {
    for (const n of [0, 37, 1.5, -1, Number.NaN]) expect(() => run([base()], [], { forecastWindowMonths: n })).toThrow(/window/i);
    expect(() => run([base()], [], { forecastWindowMonths: 1 })).not.toThrow();
    const months = Array.from({ length: 36 }, (_, i) => `${2023 + Math.floor((i + 9) / 12)}-${String(((i + 9) % 12) + 1).padStart(2, "0")}`);
    expect(() => run([base({ sales: flat(10, 36) })], [], { forecastWindowMonths: 36 }, [], months)).not.toThrow();
  });
  it("anomaly thresholds and stock date are validated", () => {
    expect(() => run([base()], [], { anomaly: { multiple: 0, floor: 40 } })).toThrow(/anomaly/i);
    expect(() => run([base()], [], { anomaly: { multiple: 5, floor: -1 } })).toThrow(/anomaly/i);
    expect(() => run([base()], [], { stockDate: "31/10/2026" })).toThrow(/stock date/i);
    expect(() => run([base()], [], { stockDate: "2026-02-30" })).toThrow(/stock date/i);
  });
  it("is deterministic and does not mutate its input", () => {
    const ds = makeDataset({ skus: [base({ sales: [1, 2, 3, 4, 5, 600] })], pos: [{ poNo: "P", sku: "S1", qty: 5, etaStores: "2026-11-20", status: "On order" }] });
    const before = JSON.stringify(ds);
    const a = JSON.stringify(runRedFlag(ds, {}, []));
    const b = JSON.stringify(runRedFlag(ds, {}, []));
    expect(a).toBe(b);
    expect(JSON.stringify(ds)).toBe(before);
  });
  it("defaults match the brief", () => {
    expect(DEFAULT_RED_FLAG_CONFIG).toMatchObject({ stockDate: "2026-10-31", forecastWindowMonths: 6, horizonWeeks: 13, overdueOnWater: "week-1", anomaly: { multiple: 5, floor: 40 } });
  });
});

describe("review hardening", () => {
  it("P2-3: ambiguous or negated PO statuses are unclassified, not silently received or on the water", () => {
    for (const t of ["Awaiting delivery", "Not yet delivered", "Delivery pending", "Arriving", "Partially received", "Production complete", "Incomplete", "Not shipped", "Unshipped", "???"]) expect(classifyPoStatus(t), t).toBe("unclassified");
    for (const t of ["Received", "Delivered", "Closed", "Cancelled", "Complete"]) expect(classifyPoStatus(t), t).toBe("received");
    for (const t of ["On the water", "In transit", "Shipped"]) expect(classifyPoStatus(t), t).toBe("on-water");
    for (const t of ["On order", "Open", "Confirmed"]) expect(classifyPoStatus(t), t).toBe("on-order");
  });
  it("P2-5: an exclusion cannot target a month with no observation", () => {
    expect(() => run([base({ sales: [40, 40, null, 40, 40, 40] })], [], {}, [{ sku: "S1", month: "2026-05", reason: "r" }])).toThrow(/no observation/i);
  });
  it("P2-2: a style's projected opening and minimum are on the same basis as its balances when a SKU has no forecast", () => {
    const r = run([base({ sku: "A", size: "S", jhb: 100, committed: 0, sales: flat(0) }), base({ sku: "B", size: "M", jhb: 50, committed: 0, sales: [null, 1, 1, 1, 1, 1], minLevel: 7 })]);
    const st = r.styles[0];
    expect(st.available).toBe(150);
    expect(st.projectedOpening).toBe(100);
    expect(st.balances[0]).toBe(100);
    expect(st.minLevel).toBe(10);
  });
  it("P3: last-available never uses months after the stock date", () => {
    const months = ["2026-08", "2026-09", "2026-10", "2026-11", "2026-12"];
    const r = run([base({ sales: [1, 2, 3, 400, 500] })], [], { forecastWindowMonths: 3 }, [], months);
    expect(r.window.months).toEqual(["2026-08", "2026-09", "2026-10"]);
    expect(sku(r).monthlyForecast).toBe(2);
  });
  it("P2-1: stored exclusions are reported independent of the detector", () => {
    const r = run([base({ sales: [40, 40, 40, 40, 40, 90] })], [], { anomaly: { multiple: 50, floor: 1000 } }, [{ sku: "S1", month: "2026-08", reason: "r" }]);
    expect(r.anomalies).toHaveLength(0);
    expect(r.summary.exclusionsApplied).toBe(1);
    expect(sku(r).excludedMonths).toEqual(["2026-08"]);
  });
});
