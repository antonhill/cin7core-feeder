import { describe, expect, it } from "vitest";
import { runRedFlag } from "@/rwtsa-demo/engine";
import { REV2_CURVE_LABEL, REV2_CURVE_PROVENANCE, REV2_SIZE_CURVE } from "@/rwtsa-demo/engine/size-curve";
import { allocateUnits } from "@/rwtsa-demo/engine/inbound";
import { makeDataset, type PoSpec, type SkuSpec } from "./engine-fixture";
import type { RwtsaDataset } from "@/rwtsa-demo/dataset";

/** Synthetic hand-checkable data only. Scenario A core: stale history, 6 v 12 month comparison, Rev2 size curve, overdue inbound, cover, net requirement. */

const M12 = ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];
const flat = (n: number, len = 12): number[] => Array.from({ length: len }, () => n);
const ds = (skus: SkuSpec[], pos: PoSpec[] = [], months = M12): RwtsaDataset => makeDataset({ months, skus, pos });
const run = (d: RwtsaDataset, cfg = {}) => runRedFlag(d, { historyAnchor: "last-available", ...cfg });

describe("stale history is shown, never invented", () => {
  const d = ds([{ sku: "A-M", sales: [...flat(0, 6), 10, 20, 30, 40, 50, 60] }]);
  it("reports the last observed month, the stock date, the missing months and a stale warning", () => {
    const r = run(d);
    expect(r.window.windowEnd).toBe("2026-08");
    expect(r.window.lastHistoryMonth).toBe("2026-08");
    expect(r.config.stockDate).toBe("2026-10-31");
    expect(r.window.gapMonths).toEqual(["2026-09", "2026-10"]);
    expect(r.window.staleMonths).toBe(2);
    expect(r.window.staleWarning).toMatch(/STALE HISTORY/);
    expect(r.window.staleWarning).toContain("2026-09, 2026-10");
    expect(r.window.staleWarning).toMatch(/none is invented/i);
  });
  it("the default basis is the latest six OBSERVED months: Sep and Oct contribute nothing", () => {
    const r = run(d);
    expect(r.window.months).toEqual(["2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"]);
    expect(r.skus[0].monthlyForecast).toBe(35); // (10+20+30+40+50+60)/6
  });
  it("current history has no warning", () => {
    const r = run(ds([{ sku: "A-M", sales: flat(5) }], [], M12), { stockDate: "2026-08-31" });
    expect(r.window.staleMonths).toBe(0);
    expect(r.window.staleWarning).toBeNull();
  });
});

describe("DP-04: six- and twelve-month averages side by side, reconciled to the source reference averages", () => {
  const sales = [...flat(0, 6), 10, 20, 30, 40, 50, 60];
  const withRefs = (ref6: number | null, ref12: number | null) => {
    const d = ds([{ sku: "A-M", sales }]);
    return { ...d, tables: { ...d.tables, salesFileAverages: [{ sku: "A-M", avg6: ref6, avg12: ref12 }] } };
  };
  it("computes both averages ending at the window end and matches the file's references", () => {
    const c = run(withRefs(35, 17.5)).comparison;
    expect(c.windowEnd).toBe("2026-08");
    expect(c.rows[0]).toMatchObject({ avg6: 35, avg12: 17.5, ref6: 35, ref12: 17.5, match6: true, match12: true });
    expect([c.compared6, c.matched6, c.compared12, c.matched12]).toEqual([1, 1, 1, 1]);
  });
  it("flags a reference that disagrees", () => {
    const c = run(withRefs(36, 17.5)).comparison;
    expect(c.rows[0].match6).toBe(false);
    expect(c.matched6).toBe(0);
    expect(c.matched12).toBe(1);
  });
  it("a missing reference is not compared; a history shorter than 12 months has no 12-month average (nothing is invented)", () => {
    const short = ds([{ sku: "A-M", sales: flat(10, 6) }], [], M12.slice(6));
    const c = run({ ...short, tables: { ...short.tables, salesFileAverages: [{ sku: "A-M", avg6: 10, avg12: null }] } }).comparison;
    expect(c.rows[0].avg12).toBeNull();
    expect(c.rows[0].match12).toBeNull();
    expect(c.compared12).toBe(0);
    expect(c.rows[0].match6).toBe(true);
    expect(run(ds([{ sku: "A-M", sales }])).comparison.rows[0].match6).toBeNull();
  });
  it("planner exclusions do not alter the raw reconciliation", () => {
    const r = runRedFlag(withRefs(35, 17.5), { historyAnchor: "last-available" }, [{ sku: "A-M", month: "2026-08", reason: "test" }]);
    expect(r.comparison.rows[0].avg6).toBe(35);
  });
});

describe("Rev2 size curve: style-level quantities split to sizes exactly and deterministically", () => {
  const SIZES = ["S", "M", "L", "XL", "2XL", "3XL", "4XL", "5XL"];
  const style8 = SIZES.map((size): SkuSpec => ({ sku: `ST-${size}`, style: "ST", size, minLevel: 0, sales: flat(10) }));
  const po = (qty: number): PoSpec => ({ poNo: "PO-1", style: "ST", qty, etaStores: "2026-11-20", status: "On order" });
  const curve = { kind: "explicit" as const, weights: REV2_SIZE_CURVE, label: REV2_CURVE_LABEL, provenance: REV2_CURVE_PROVENANCE };
  it("allocates a round quantity in the documented 10/20/24/20/12/8/4/2 proportions", () => {
    const r = run(ds(style8, [po(1000)]), { sizeCurve: curve });
    expect(r.skus.map((s) => s.inboundTotal)).toEqual([100, 200, 240, 200, 120, 80, 40, 20]);
    expect(r.inbound.sizeAllocation.reconciles).toBe(true);
    expect(r.inbound.sizeAllocation.unitsIn).toBe(1000);
    expect(r.inbound.sizeAllocation.unitsAllocated).toBe(1000);
  });
  it("preserves the exact aggregate for awkward quantities, with deterministic largest-remainder rounding", () => {
    for (const q of [1, 7, 99, 101, 333, 1001]) {
      const r = run(ds(style8, [po(q)]), { sizeCurve: curve });
      expect(r.skus.reduce((a, s) => a + s.inboundTotal, 0), String(q)).toBe(q);
      expect(r.inbound.sizeAllocation.reconciles).toBe(true);
      const again = run(ds(style8, [po(q)]), { sizeCurve: curve });
      expect(again.skus.map((s) => s.inboundTotal)).toEqual(r.skus.map((s) => s.inboundTotal));
    }
    // 101 x [10,20,24,20,12,8,4,2]% = 10.1, 20.2, 24.24, 20.2, 12.12, 8.08, 4.04, 2.02: floors 10,20,24,20,12,8,4,2 (=100); the one left unit goes to the largest remainder (24.24 -> L)
    expect(run(ds(style8, [po(101)]), { sizeCurve: curve }).skus.map((s) => s.inboundTotal)).toEqual([10, 20, 25, 20, 12, 8, 4, 2]);
    // ties on the fractional part go to the earlier size, so the result does not depend on iteration quirks
    expect(allocateUnits(1, [["a", 1], ["b", 1]])).toEqual([["a", 1], ["b", 0]]);
  });
  it("records each allocated line with its sizes and labels the applied curve and where it comes from", () => {
    const r = run(ds(style8, [po(101)]), { sizeCurve: curve });
    const line = r.inbound.sizeAllocation.lines[0];
    expect([line.styleCode, line.poNo, line.qty]).toEqual(["ST", "PO-1", 101]);
    expect(line.parts.map((p) => [p.size, p.units])).toEqual([["S", 10], ["M", 20], ["L", 25], ["XL", 20], ["2XL", 12], ["3XL", 8], ["4XL", 4], ["5XL", 2]]);
    expect(r.inbound.sizeAllocation.curveLabel).toBe(REV2_CURVE_LABEL);
    expect(r.inbound.sizeAllocation.curveProvenance).toMatch(/Rev 2/);
  });
  it("a style missing some sizes is split over the sizes it has, still exactly", () => {
    const three = ["S", "M", "L"].map((size): SkuSpec => ({ sku: `T-${size}`, style: "ST", size, minLevel: 0, sales: flat(10) }));
    const r = run(ds(three, [po(100)]), { sizeCurve: curve });
    expect(r.skus.reduce((a, s) => a + s.inboundTotal, 0)).toBe(100);
    expect(r.skus.map((s) => s.inboundTotal)).toEqual([19, 37, 44]); // 10:20:24 of 54 -> 18.5, 37.04, 44.44 -> floors 18,37,44 + 1 to the largest remainder (S .52)
  });
  it("lines already at SKU level are not split and are not in the allocation report", () => {
    const r = run(ds(style8, [{ poNo: "PO-2", sku: "ST-M", qty: 50, etaStores: "2026-11-20", status: "On order" }]), { sizeCurve: curve });
    expect(r.inbound.sizeAllocation.lines).toEqual([]);
    expect(r.skus.find((s) => s.sku === "ST-M")!.inboundTotal).toBe(50);
  });
  it("without a curve nothing is invented: the quantity stays unallocated and is reported", () => {
    const r = run(ds(style8, [po(100)]), { sizeCurve: { kind: "none" } });
    expect(r.inbound.unallocatedStyleUnits).toBe(100);
    expect(r.inbound.sizeAllocation.lines).toEqual([]);
  });
  it("the Rev2 weights sum to 100", () => {
    expect(Object.values(REV2_SIZE_CURVE).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("overdue shipments are kept apart from stock and never counted as received", () => {
  const sku: SkuSpec = { sku: "A-M", minLevel: 0, jhb: 100, inTransit: 40, sales: flat(10) };
  const overdue: PoSpec = { poNo: "PO-O", sku: "A-M", qty: 40, etaStores: "2026-10-20", status: "On the water" };
  it("'exclude' leaves overdue on-water units out of usable inbound and out of opening Available, and reports them", () => {
    const r = run(ds([sku], [overdue]), { overdueOnWater: "exclude" });
    expect(r.skus[0].available).toBe(100);
    expect(r.skus[0].inboundTotal).toBe(0);
    expect(r.inbound.overdueOnWaterUnits).toBe(40);
    expect(r.inbound.overdueExcludedUnits).toBe(40);
    expect(r.assumptions.find((a) => a.id === "overdue-on-water")!.text).toMatch(/DEMONSTRATION ASSUMPTION, not an established customer policy/);
    expect(r.assumptions.find((a) => a.id === "overdue-on-water")!.text).toMatch(/NOT counted as received/);
  });
  it("the alternative treatment is labelled too, and moves the units into week 1 only when chosen", () => {
    const r = run(ds([sku], [overdue]), { overdueOnWater: "week-1" });
    expect(r.skus[0].inboundWeeks[0]).toBe(40);
    expect(r.inbound.overdueOnWaterUnits).toBe(40);
    expect(r.assumptions.find((a) => a.id === "overdue-on-water")!.text).toMatch(/DEMONSTRATION ASSUMPTION/);
  });
  it("Stock In transit is never added to on-water purchase orders: the same goods are not counted twice", () => {
    const future: PoSpec = { poNo: "PO-F", sku: "A-M", qty: 40, etaStores: "2026-11-20", status: "On the water" };
    const r = run(ds([sku], [future]), { overdueOnWater: "exclude" });
    expect(r.skus[0].inboundTotal).toBe(40); // the PO, once
    expect(r.skus[0].available).toBe(100); // In transit (40) is not in Available
    expect(r.inbound.reconciliation.inTransitStockUnits).toBe(40);
    expect(r.inbound.reconciliation.onWaterPoUnits).toBe(40);
    expect(r.inbound.reconciliation.skusConsistent).toBe(1);
  });
  it("overdue lines that are only on order are not on-water overdue units", () => {
    const r = run(ds([sku], [{ ...overdue, status: "On order" }]), { overdueOnWater: "exclude" });
    expect(r.inbound.overdueOnWaterUnits).toBe(0);
    expect(r.inbound.overdueOnOrderUnits).toBe(40);
  });
});

describe("DP-17 months of cover includes usable inbound; opening cover stays visible", () => {
  const sales = flat(30);
  it("cover = (opening Available + usable inbound inside the horizon) / average monthly demand; opening cover is separate", () => {
    const r = run(ds([{ sku: "A-M", minLevel: 0, jhb: 70, committed: 10, sales }], [{ poNo: "P", sku: "A-M", qty: 30, etaStores: "2026-11-20", status: "On order" }]));
    const s = r.skus[0];
    expect(s.available).toBe(60); // 70 - committed 10: committed is netted once, here only
    expect(s.monthsOfCover).toBe(2); // 60 / 30
    expect(s.coverInboundUnits).toBe(30);
    expect(s.monthsOfCoverWithInbound).toBe(3); // (60 + 30) / 30
  });
  it("inbound beyond the horizon, overdue-excluded inbound and received lines are not in the cover", () => {
    const pos: PoSpec[] = [
      { poNo: "FAR", sku: "A-M", qty: 100, etaStores: "2027-03-01", status: "On order" },
      { poNo: "LATE", sku: "A-M", qty: 100, etaStores: "2026-10-01", status: "On the water" },
      { poNo: "DONE", sku: "A-M", qty: 100, etaStores: "2026-11-10", status: "Received" },
    ];
    const s = run(ds([{ sku: "A-M", minLevel: 0, jhb: 60, sales }], pos), { overdueOnWater: "exclude" }).skus[0];
    expect(s.coverInboundUnits).toBe(0);
    expect(s.monthsOfCoverWithInbound).toBe(2);
  });
  it("a longer horizon admits more inbound", () => {
    const pos: PoSpec[] = [{ poNo: "P", sku: "A-M", qty: 30, etaStores: "2027-02-20", status: "On order" }];
    const d = ds([{ sku: "A-M", minLevel: 0, jhb: 60, sales }], pos);
    expect(run(d, { horizonWeeks: 13 }).skus[0].monthsOfCoverWithInbound).toBe(2);
    expect(run(d, { horizonWeeks: 26 }).skus[0].monthsOfCoverWithInbound).toBe(3);
  });
  it("no demand means no cover figure rather than infinity", () => {
    expect(run(ds([{ sku: "A-M", jhb: 10, sales: flat(0) }])).skus[0].monthsOfCoverWithInbound).toBeNull();
  });
  it("the style figure is a ratio of sums, not an average of ratios", () => {
    const r = run(ds([
      { sku: "S-S", style: "ST", size: "S", minLevel: 0, jhb: 10, sales: flat(10) },
      { sku: "S-M", style: "ST", size: "M", minLevel: 0, jhb: 90, sales: flat(30) },
    ], [{ poNo: "P", sku: "S-S", qty: 20, etaStores: "2026-11-20", status: "On order" }]));
    expect(r.styles[0].monthsOfCover).toBe(2.5); // (10 + 90) / (10 + 30)
    expect(r.styles[0].monthsOfCoverWithInbound).toBe(3); // (100 + 20) / 40
  });
});

describe("DP-13: the RFP net requirement is reported beside, never instead of, the approved minimum-shortfall proposal", () => {
  const sales = flat(100);
  it("computes both, with different formulas and labels", () => {
    const s = run(ds([{ sku: "A-M", minLevel: 20, jhb: 50, sales }]), { horizonWeeks: 13 }).skus[0];
    // weekly = 100 / 4.345; demand over 13 weeks = 299.19...
    expect(s.netRequirement).toBe(250); // ceil(299.19 - 50 - 0)
    expect(s.proposedOrder).toBe(270); // approved rule: ceil(20 - (50 - 299.19)) = 270
    expect(s.netRequirement).not.toBe(s.proposedOrder);
  });
  it("usable inbound reduces the net requirement; a tender SKU is never auto-replenished", () => {
    const withPo = run(ds([{ sku: "A-M", minLevel: 20, jhb: 50, sales }], [{ poNo: "P", sku: "A-M", qty: 100, etaStores: "2026-11-20", status: "On order" }])).skus[0];
    expect(withPo.netRequirement).toBe(150);
    const tender = run(ds([{ sku: "A-M", minLevel: 20, jhb: 50, tender: true, sales }])).skus[0];
    expect(tender.netRequirement).toBe(0);
    expect(tender.proposedOrder).toBe(0);
  });
  it("is never negative and is null when the SKU cannot be forecast", () => {
    expect(run(ds([{ sku: "A-M", minLevel: 0, jhb: 100000, sales }])).skus[0].netRequirement).toBe(0);
    expect(run(ds([{ sku: "A-M", jhb: 1, sales: [null, ...flat(5, 11)] }]), { forecastWindowMonths: 12 }).skus[0].netRequirement).toBeNull();
  });
  it("the horizon changes both figures, and the style value is the sum of its SKUs", () => {
    const d = ds([{ sku: "S-S", style: "ST", size: "S", minLevel: 0, jhb: 50, sales }, { sku: "S-M", style: "ST", size: "M", minLevel: 0, jhb: 50, sales }]);
    const a = run(d, { horizonWeeks: 13 });
    const b = run(d, { horizonWeeks: 26 });
    expect(b.skus[0].netRequirement as number).toBeGreaterThan(a.skus[0].netRequirement as number);
    expect(a.styles[0].netRequirement).toBe((a.skus[0].netRequirement as number) + (a.skus[1].netRequirement as number));
  });
});
