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

describe("USD exposure by due date: settlement is never assumed", () => {
  it("lists every payment and treats none as settled without evidence; a past due date is not evidence of payment", () => {
    const r = run();
    expect(r.asOf).toBe("2026-10-31");
    expect(r.rows.every((x) => x.settlement === "unknown")).toBe(true);
    expect(fromCents(r.totals.scheduledUsdCents)).toBe(5000 + 4000 + 2500.5 + 1000);
    expect(fromCents(r.totals.potentialUsdCents)).toBe(5000 + 4000 + 2500.5 + 1000);
    expect(r.totals.paidUsdCents).toBe(0);
    expect(r.totals.confirmedOpenUsdCents).toBeNull(); // nothing is confirmed open: not "0"
    expect(r.rows.find((x) => x.poNo === "PO-0")!.pastDue).toBe(true);
    expect(fromCents(r.totals.pastDueUnknownUsdCents)).toBe(1000);
    expect(r.warnings.join(" ")).toMatch(/no settlement evidence/i);
    expect(r.warnings.join(" ")).toMatch(/past due date is not evidence of payment/i);
  });
  it("moving a due date from future to overdue does NOT remove it from the exposure (regression for the zero-exposure defect)", () => {
    const future = run([{ po: "A", due: "2026-11-30", usd: 700 }]);
    const overdue = run([{ po: "A", due: "2026-10-01", usd: 700 }]);
    expect(future.totals.potentialUsdCents).toBe(70000);
    expect(overdue.totals.potentialUsdCents).toBe(70000);
    expect(overdue.totals.potentialUsdCents).toBe(future.totals.potentialUsdCents);
    expect(overdue.rows[0].pastDue).toBe(true);
    expect(future.rows[0].pastDue).toBe(false);
    // and an all-overdue schedule (the real-workbook shape) is never shown as zero
    const allPast = run([{ po: "A", due: "2026-09-01", usd: 100 }, { po: "B", due: "2026-10-06", usd: 200 }]);
    expect(allPast.totals.potentialUsdCents).toBe(30000);
    expect(allPast.buckets.reduce((a, b) => a + b.usdCents, 0)).toBe(30000);
  });
  it("changing the as-at date moves rows between overdue and not yet due, never in or out of the exposure", () => {
    const a = run(PAYS, { asOf: "2026-10-01" });
    const b = run(PAYS, { asOf: "2027-06-01" });
    expect(a.totals.potentialUsdCents).toBe(b.totals.potentialUsdCents);
    expect(a.totals.pastDueUnknownUsdCents).not.toBe(b.totals.pastDueUnknownUsdCents);
    expect(() => run(PAYS, { asOf: "15/11/2026" })).toThrow(/as-at/i);
    expect(() => run(PAYS, { bucket: "day" as never })).toThrow(/bucket/i);
  });
  it("a payment due exactly on the as-at date is not past due; the day before is", () => {
    const r = run([{ po: "P1", due: "2026-10-31", usd: 100 }, { po: "P2", due: "2026-10-30", usd: 50 }]);
    expect(r.rows.map((x) => [x.poNo, x.pastDue])).toEqual([["P1", false], ["P2", true]]);
  });
  it("confirmed paid needs explicit evidence: a paid status, or a paid date", () => {
    const r = run([
      { po: "S", due: "2026-09-01", usd: 100, status: "Paid" },
      { po: "D", due: "2026-09-01", usd: 200, paidDate: "2026-09-02" },
      { po: "N", due: "2026-09-01", usd: 400 },
    ]);
    expect(r.rows.map((x) => [x.poNo, x.settlement, x.settlementBasis])).toEqual([["S", "paid", "explicit-status"], ["D", "paid", "paid-date"], ["N", "unknown", "none"]]);
    expect(r.totals.paidUsdCents).toBe(30000);
    expect(r.totals.potentialUsdCents).toBe(40000);
    expect(r.totals.confirmedOpenUsdCents).toBeNull();
  });
  it("confirmed open needs explicit evidence and is kept separate from potential exposure", () => {
    const r = run([
      { po: "O", due: "2026-09-01", usd: 100, status: "Open", fec: "F", locked: 18 },
      { po: "U", due: "2026-12-01", usd: 400 },
    ]);
    expect(r.rows.map((x) => [x.poNo, x.settlement, x.settlementBasis])).toEqual([["O", "open", "explicit-open"], ["U", "unknown", "none"]]);
    expect(r.totals.confirmedOpenUsdCents).toBe(10000);
    expect(r.totals.confirmedOpenCoveredUsdCents).toBe(10000);
    expect(r.totals.confirmedOpenUncoveredUsdCents).toBe(0);
    expect(r.totals.potentialUsdCents).toBe(50000); // confirmed open + unknown
    expect(r.totals.unknownUsdCents).toBe(40000);
  });
  it("an unrecognised status, or a status that contradicts a paid date, stays unknown and is reported", () => {
    const r = run([{ po: "X", due: "2026-09-01", usd: 100, status: "chasing" }, { po: "Y", due: "2026-09-01", usd: 100, status: "Open", paidDate: "2026-09-05" }]);
    expect(r.rows.map((x) => x.settlement)).toEqual(["unknown", "unknown"]);
    expect(r.warnings.join(" ")).toMatch(/unrecognised|conflict/i);
  });
  it("a deposit is treated as paid ONLY under the documented Rev2 rule: flagged or remarked as a deposit AND payable at shipment (0 days)", () => {
    const r = run([
      { po: "D1", due: "2026-08-22", shipped: "2026-08-22", usd: 564, terms: 0, deposit: true },
      { po: "D2", due: "2026-08-22", shipped: "2026-08-22", usd: 564, terms: 0, remark: "Deposit before production (30%)" },
      { po: "D3", due: "2026-08-22", shipped: "2026-08-22", usd: 564, terms: 30, deposit: true }, // not payable at shipment: no evidence
      { po: "Q", due: "2026-08-04", usd: 11, terms: 0, remark: "Per-shipment QC cost" }, // zero terms alone is not a deposit
      { po: "B", due: "2026-10-06", usd: 1316, terms: 45, remark: "Balance after deposit" },
    ]);
    expect(r.rows.map((x) => [x.poNo, x.settlement, x.settlementBasis])).toEqual([
      ["D1", "paid", "deposit-rev2"], ["D2", "paid", "deposit-rev2"], ["D3", "unknown", "none"], ["Q", "unknown", "none"], ["B", "unknown", "none"],
    ]);
    expect(r.totals.paidUsdCents).toBe(56400 * 2);
    expect(r.totals.potentialUsdCents).toBe(56400 + 1100 + 131600);
    expect(r.warnings.join(" ")).toMatch(/Rev2/);
  });
  it("a deposit is paid only when due on its shipment date: a missing or different shipment date is not evidence", () => {
    const r = run([
      { po: "A", due: "2026-08-22", usd: 1, terms: 0, deposit: true }, // no shipment date
      { po: "B", due: "2026-08-22", shipped: "2026-08-21", usd: 1, terms: 0, deposit: true }, // due a day after shipment
      { po: "C", due: "2026-08-22", shipped: "2026-08-22", usd: 1, terms: 0, deposit: true },
    ]);
    expect(r.rows.map((x) => x.settlement)).toEqual(["unknown", "unknown", "paid"]);
  });
  it("a paid date AFTER the as-at date does not count as paid at that date: it was open then (regression)", () => {
    const pays = [{ po: "L", due: "2026-09-01", usd: 100, paidDate: "2026-11-15" }, { po: "E", due: "2026-09-01", usd: 50, paidDate: "2026-09-10" }, { po: "S", due: "2026-09-01", usd: 25, paidDate: "2026-10-31" }];
    const at = run(pays, { asOf: "2026-10-31" });
    expect(at.rows.map((x) => [x.poNo, x.settlement, x.settlementBasis])).toEqual([["L", "open", "paid-after-as-at"], ["E", "paid", "paid-date"], ["S", "paid", "paid-date"]]); // paid ON the as-at date is paid
    expect(at.totals.confirmedOpenUsdCents).toBe(10000);
    expect(at.totals.paidUsdCents).toBe(7500);
    const later = run(pays, { asOf: "2026-12-01" });
    expect(later.rows.map((x) => x.settlement)).toEqual(["paid", "paid", "paid"]);
    expect(later.totals.confirmedOpenUsdCents).toBeNull();
  });
  it("status Paid with a paid date after the as-at date is open at that date, with a warning; a deposit with an unrecognised status is not paid", () => {
    const r = run([{ po: "P", due: "2026-09-01", usd: 1, status: "Paid", paidDate: "2026-11-15" }, { po: "D", due: "2026-08-22", shipped: "2026-08-22", usd: 1, terms: 0, deposit: true, status: "chasing" }]);
    expect(r.rows.map((x) => [x.settlement, x.settlementBasis])).toEqual([["open", "paid-after-as-at"], ["unknown", "none"]]);
    expect(r.warnings.join(" ")).toMatch(/paid date after the as-at date/);
  });
  it("a deposit whose shipment is AFTER the as-at date cannot have been paid at shipment yet", () => {
    const r = run([{ po: "F", due: "2027-01-15", shipped: "2027-01-15", usd: 5, terms: 0, deposit: true }], { asOf: "2026-10-31" });
    expect(r.rows[0].settlement).toBe("unknown");
    expect(run([{ po: "F", due: "2027-01-15", shipped: "2027-01-15", usd: 5, terms: 0, deposit: true }], { asOf: "2027-01-15" }).rows[0].settlement).toBe("paid");
  });
  it("an Open status with a paid date after the as-at date is open then (not a conflict); with a paid date on or before it, a conflict", () => {
    const r = run([{ po: "A", due: "2026-09-01", usd: 1, status: "Open", paidDate: "2026-11-15" }, { po: "B", due: "2026-09-01", usd: 1, status: "Open", paidDate: "2026-10-01" }, { po: "C", due: "2026-09-01", usd: 1, status: "chasing", paidDate: "2026-11-15" }]);
    expect(r.rows.map((x) => [x.settlement, x.settlementBasis])).toEqual([["open", "paid-after-as-at"], ["unknown", "none"], ["open", "paid-after-as-at"]]);
    expect(r.warnings.join(" ")).toMatch(/conflicts with a paid date/);
    expect(r.warnings.join(" ")).toMatch(/unrecognised payment status/);
  });
  it("a remark that merely mentions a deposit, or negates or times it, is not evidence of settlement", () => {
    const r = run([
      { po: "A", due: "2026-08-22", usd: 1, terms: 0, remark: "balance after deposit" },
      { po: "B", due: "2026-08-22", usd: 1, terms: 0, remark: "Deposit not yet paid" },
      { po: "C", due: "2026-08-22", usd: 1, terms: 0, remark: "no deposit" },
      { po: "D", due: "2026-08-22", usd: 1, terms: 0, remark: "Deposit due before production" },
      { po: "E", due: "2026-08-22", shipped: "2026-08-22", usd: 1, terms: 0, remark: "Deposit before production (30%)" },
    ]);
    expect(r.rows.map((x) => x.settlement)).toEqual(["unknown", "unknown", "unknown", "unknown", "paid"]);
  });
  it("only the minimum status vocabulary is read: paid, open, unpaid; anything else is unknown", () => {
    const r = run([{ po: "A", due: "2026-09-01", usd: 1, status: "settled" }, { po: "B", due: "2026-09-01", usd: 1, status: "outstanding" }, { po: "C", due: "2026-09-01", usd: 1, status: "Unpaid" }]);
    expect(r.rows.map((x) => x.settlement)).toEqual(["unknown", "unknown", "open"]);
  });
  it("covered and uncovered are computed on the same eligibility basis as the potential exposure (paid rows are in neither)", () => {
    const r = run([
      { po: "C", due: "2026-09-01", usd: 100, fec: "F", locked: 18 },
      { po: "U", due: "2026-09-01", usd: 50 },
      { po: "P", due: "2026-09-01", usd: 999, fec: "F2", locked: 18, status: "Paid" },
    ]);
    expect(r.totals.potentialCoveredUsdCents).toBe(10000);
    expect(r.totals.potentialUncoveredUsdCents).toBe(5000);
    expect(r.totals.potentialCoveredUsdCents + r.totals.potentialUncoveredUsdCents).toBe(r.totals.potentialUsdCents);
    for (const b of r.buckets) expect(b.coveredUsdCents + b.uncoveredUsdCents).toBe(b.usdCents);
  });
  it("an FEC reference without a locked rate is not cover", () => {
    const r = run([{ po: "P", due: "2026-11-10", usd: 100, fec: "F", locked: null }]);
    expect(r.totals.potentialCoveredUsdCents).toBe(0);
    expect(r.rows[0].covered).toBe(false);
  });
  it("buckets by month and week; overdue rows have their own first bucket; buckets sum to the potential total exactly", () => {
    const m = run(PAYS, { bucket: "month" });
    expect(m.buckets.map((b) => [b.key, fromCents(b.usdCents)])).toEqual([["Overdue (due before as-at)", 1000], ["2026-11", 9000], ["2026-12", 2500.5]]);
    const w = run(PAYS, { bucket: "week" });
    expect(w.buckets.map((b) => b.key)).toEqual(["Overdue (due before as-at)", "week 2", "week 3", "week 5"]);
    for (const r of [m, w]) {
      expect(r.buckets.reduce((a, b) => a + b.usdCents, 0)).toBe(r.totals.potentialUsdCents);
      expect(r.buckets.reduce((a, b) => a + b.coveredUsdCents + b.uncoveredUsdCents, 0)).toBe(r.totals.potentialUsdCents);
    }
  });
  it("USD amounts are summed in whole cents (no floating-point drift)", () => {
    const r = run([{ po: "A", due: "2026-11-10", usd: 0.1 }, { po: "B", due: "2026-11-10", usd: 0.2 }, { po: "C", due: "2026-11-10", usd: 33.33 }]);
    expect(r.totals.potentialUsdCents).toBe(10 + 20 + 3333);
  });
  it("marks deposits", () => {
    expect(run().rows.find((x) => x.poNo === "PO-3")!.deposit).toBe(true);
  });
  it("an empty Payments_FEC tab gives an empty, honest result", () => {
    const r = run([]);
    expect(r.rows).toEqual([]);
    expect(r.totals.potentialUsdCents).toBe(0);
    expect(r.totals.confirmedOpenUsdCents).toBeNull();
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
