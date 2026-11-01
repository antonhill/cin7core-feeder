import { describe, expect, it } from "vitest";
import { groupCheck, periodKey, reconcileGroups, runQuoteConversion, type Metrics } from "@/rwtsa-demo/engine/quote-conversion";
import { quoteDataset, REFERENCE, type QSpec } from "./quote-fixture";

/**
 * Quote conversion engine. All expected numbers are worked out by hand from REFERENCE (quote-fixture.ts):
 *   Q1 won 1,000.00 | Q2 won 2,000.50 | Q3 lost 1,500.00 | Q4 lost 500.25 | Q5 open 3,000.00 | Q6 unrecognised 700.00
 *   closed = 4 (Q1-Q4) | count conversion = 2/4 = 50% | won 3,000.50 | closed 5,000.75 | value conversion = 300050/500075 = 60.001%
 */

const run = (specs: QSpec[], o: Parameters<typeof runQuoteConversion>[1] = {}, d: Parameters<typeof quoteDataset>[1] = {}) => runQuoteConversion(quoteDataset(specs, d), o);
const ref = () => run(REFERENCE);
const by = <T extends { key: string }>(rows: readonly T[], key: string): T => {
  const r = rows.find((x) => x.key === key);
  if (!r) throw new Error(`no group ${key}`);
  return r;
};
const sumOf = (rows: readonly Metrics[], f: (m: Metrics) => number) => rows.reduce((a, m) => a + f(m), 0);

describe("status classification", () => {
  it("classifies won, lost and open (case-insensitive) and leaves the unrecognised one UNCLASSIFIED", () => {
    const r = ref();
    expect(r.records.map((q) => `${q.ref}:${q.status}`)).toEqual(["Q1:WON", "Q2:WON", "Q3:LOST", "Q4:LOST", "Q5:OPEN", "Q6:UNCLASSIFIED"]);
    expect(r.total).toMatchObject({ quotes: 6, won: 2, lost: 2, open: 1, unclassified: 1, closed: 4 });
  });
  it("reports the unrecognised status and the distinct raw values, and never counts it as OPEN", () => {
    const r = ref();
    expect(r.issues.unclassified_status).toBe(1);
    expect(r.unclassifiedValues).toEqual(["Pending review"]);
    expect(r.total.open).toBe(1);
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.reasons.join(" ")).toMatch(/not recognised/i);
  });
  it("a blank status is UNCLASSIFIED, not OPEN", () => {
    const r = run([{ no: "A", status: "" }, { no: "B", status: "open" }]);
    expect(r.total).toMatchObject({ open: 1, unclassified: 1 });
  });
});

describe("count conversion = won / (won + lost) x 100", () => {
  it("is 50% on the reference set", () => {
    expect(ref().total.countConversionPct).toBe(50);
  });
  it("open quotes are excluded from the denominator", () => {
    const a = run([{ no: "1", status: "won" }, { no: "2", status: "lost", reason: "x" }]);
    const b = run([{ no: "1", status: "won" }, { no: "2", status: "lost", reason: "x" }, { no: "3", status: "open" }, { no: "4", status: "open" }]);
    expect(a.total.countConversionPct).toBe(50);
    expect(b.total.countConversionPct).toBe(50);
    expect(b.total.closed).toBe(2);
  });
  it("unclassified quotes are excluded from the denominator", () => {
    const r = run([{ no: "1", status: "won" }, { no: "2", status: "weird" }, { no: "3", status: "weird" }]);
    expect(r.total.closed).toBe(1);
    expect(r.total.countConversionPct).toBe(100);
  });
  it("is N/A (null), not 0%, when there are no closed quotes", () => {
    const r = run([{ no: "1", status: "open" }, { no: "2", status: "weird" }]);
    expect(r.total.closed).toBe(0);
    expect(r.total.countConversionPct).toBeNull();
    expect(r.total.valueConversionPct).toBeNull();
    expect(run([]).total.countConversionPct).toBeNull();
  });
  it("is a genuine 0% when closed quotes exist and none were won", () => {
    const r = run([{ no: "1", status: "lost", reason: "x" }]);
    expect(r.total.countConversionPct).toBe(0);
  });
  it("computes thirds without rounding inside the engine", () => {
    const r = run([{ no: "1", status: "won", so: "S" }, { no: "2", status: "lost", reason: "x" }, { no: "3", status: "lost", reason: "x" }]);
    expect(r.total.countConversionPct).toBeCloseTo(33.3333333, 6);
  });
});

describe("value conversion = won value / (won + lost value) x 100, in integer cents", () => {
  it("is 300050 / 500075 on the reference set", () => {
    const t = ref().total;
    expect(t.wonCents).toBe(300050);
    expect(t.lostCents).toBe(200025);
    expect(t.closedCents).toBe(500075);
    expect(t.openCents).toBe(300000);
    expect(t.unclassifiedCents).toBe(70000);
    expect(t.valueConversionPct).toBeCloseTo(60.001, 3);
  });
  it("differs from count conversion when values differ (value is not count)", () => {
    const r = run([{ no: "1", status: "won", so: "S", value: 100 }, { no: "2", status: "lost", reason: "x", value: 900 }]);
    expect(r.total.countConversionPct).toBe(50);
    expect(r.total.valueConversionPct).toBe(10);
  });
  it("open and unclassified values never enter the closed value", () => {
    const r = run([{ no: "1", status: "won", so: "S", value: 100 }, { no: "2", status: "open", value: 1e6 }, { no: "3", status: "weird", value: 1e6 }]);
    expect(r.total.closedCents).toBe(10000);
    expect(r.total.valueConversionPct).toBe(100);
  });
  it("zero-value quotes: all-zero closed value is N/A, a zero-value quote still counts in the count basis", () => {
    const z = run([{ no: "1", status: "won", so: "S", value: 0 }, { no: "2", status: "lost", reason: "x", value: 0 }]);
    expect(z.total.closed).toBe(2);
    expect(z.total.countConversionPct).toBe(50);
    expect(z.total.closedCents).toBe(0);
    expect(z.total.valueConversionPct).toBeNull();
    const m = run([{ no: "1", status: "won", so: "S", value: 0 }, { no: "2", status: "lost", reason: "x", value: 200 }]);
    expect(m.total.valueConversionPct).toBe(0);
  });
  it("sums in whole cents, so 0.10 + 0.20 is exactly 30 cents (no floating-point drift)", () => {
    const r = run([{ no: "1", status: "won", so: "A", value: 0.1 }, { no: "2", status: "won", so: "B", value: 0.2 }, { no: "3", status: "lost", reason: "x", value: 0.3 }]);
    expect(r.total.wonCents).toBe(30);
    expect(r.total.closedCents).toBe(60);
    expect(r.total.valueConversionPct).toBe(50);
  });
  it("rounds a sub-cent value half away from zero, and a total of many small values stays exact", () => {
    expect(run([{ no: "1", status: "won", so: "A", value: 10.005 }]).total.wonCents).toBe(1001);
    const many = Array.from({ length: 1000 }, (_, i) => ({ no: `Q${i}`, status: "won", so: `S${i}`, value: 0.01 }));
    expect(run(many).total.wonCents).toBe(1000);
  });
});

describe("validation findings", () => {
  it("a LOST quote with no reason is a finding and makes the win/loss analysis incomplete; no default reason is invented", () => {
    const r = run([{ no: "1", status: "lost", reason: null, value: 500 }, { no: "2", status: "lost", reason: "   ", value: 100 }, { no: "3", status: "lost", reason: "Price", value: 50 }, { no: "4", status: "won", so: "S" }]);
    expect(r.issues.lost_reason_missing).toBe(2);
    expect(r.reasons.complete).toBe(false);
    expect(r.reasons.missing).toEqual({ count: 2, cents: 60000 });
    expect(r.reasons.rows.map((x) => x.reason)).toEqual(["Price"]);
    expect(r.records.filter((q) => q.issues.includes("lost_reason_missing")).map((q) => q.ref)).toEqual(["1", "2"]);
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.winLossComplete).toBe(false);
    expect(r.total.lost).toBe(3); // still lost, still in conversion
  });
  it("a WON quote with no converted sales-order reference is an incomplete conversion record; no number is generated", () => {
    const r = run([{ no: "1", status: "won", so: null }, { no: "2", status: "won", so: "  " }, { no: "3", status: "won", so: "SO-9" }]);
    expect(r.issues.conversion_ref_missing).toBe(2);
    expect(r.conversion.withReference).toBe(1);
    expect(r.conversion.missingReference).toBe(2);
    expect(r.records.map((q) => q.convertedOrder)).toEqual([null, null, "SO-9"]);
    expect(r.completeness.conversionComplete).toBe(false);
  });
  it("preserves the original sales-order reference exactly as supplied", () => {
    const r = ref();
    expect(r.records.find((q) => q.ref === "Q2")?.convertedOrder).toBe("So-2/b");
    expect(r.conversion.references.map((x) => x.order)).toEqual(["SO-1", "So-2/b"]);
  });
  it("a reference on a quote that is not WON is flagged and is not treated as a conversion", () => {
    const r = run([{ no: "1", status: "open", so: "SO-X" }, { no: "2", status: "lost", reason: "x", so: "SO-Y" }]);
    expect(r.issues.order_ref_on_non_won).toBe(2);
    expect(r.conversion.withReference).toBe(0);
  });
  it("the same sales order on two won quotes is flagged", () => {
    const r = run([{ no: "1", status: "won", so: "SO-1" }, { no: "2", status: "won", so: "SO-1" }]);
    expect(r.issues.order_ref_duplicate).toBe(2);
  });
  it("detects duplicate quote numbers (case-insensitive); the first is analysed, later ones are excluded and reported", () => {
    const r = run([{ no: "Q1", status: "won", so: "S", value: 100 }, { no: "q1 ", status: "lost", reason: "x", value: 900 }, { no: "Q2", status: "open" }]);
    expect(r.duplicates).toEqual(["q1"]);
    expect(r.issues.duplicate_quote).toBe(1);
    expect(r.total.quotes).toBe(2);
    expect(r.total.lost).toBe(0);
    expect(r.completeness.complete).toBe(false);
  });
  it("a missing, negative or non-finite value is flagged and excluded from value totals but stays in the counts", () => {
    const r = run([{ no: "1", status: "won", so: "S", value: Number.NaN }, { no: "2", status: "lost", reason: "x", value: -5 }, { no: "3", status: "won", so: "T", value: 100 }]);
    expect(r.issues.value_invalid).toBe(2);
    expect(r.total.valueMissing).toBe(2);
    expect(r.total.closed).toBe(3);
    expect(r.total.wonCents).toBe(10000);
    expect(r.total.closedCents).toBe(10000);
    expect(r.completeness.valuesComplete).toBe(false);
  });
  it("a clean set is complete", () => {
    const r = run([{ no: "1", status: "won", so: "S" }, { no: "2", status: "lost", reason: "x" }, { no: "3", status: "open" }]);
    expect(r.completeness).toMatchObject({ complete: true, reasons: [] });
  });
  it("open quotes need neither a reason nor a reference", () => {
    expect(run([{ no: "1", status: "open" }]).completeness.complete).toBe(true);
  });
  it("lists the quotes behind each finding (references only)", () => {
    const r = run([{ no: "A1", status: "lost" }, { no: "A2", status: "won" }]);
    expect(r.issueRefs.lost_reason_missing).toEqual(["A1"]);
    expect(r.issueRefs.conversion_ref_missing).toEqual(["A2"]);
  });
});

describe("grouping and reconciliation", () => {
  it("groups by sales representative", () => {
    const r = ref();
    expect(r.byRep.map((g) => g.key)).toEqual(["R1", "R2"]);
    expect(by(r.byRep, "R1")).toMatchObject({ quotes: 3, won: 2, lost: 0, open: 0, unclassified: 1, closed: 2, wonCents: 300050, closedCents: 300050, countConversionPct: 100, valueConversionPct: 100 });
    expect(by(r.byRep, "R2")).toMatchObject({ quotes: 3, won: 0, lost: 2, open: 1, closed: 2, lostCents: 200025, countConversionPct: 0, valueConversionPct: 0 });
  });
  it("groups by customer, with N/A where a customer has no closed quotes", () => {
    const r = ref();
    expect(by(r.byCustomer, "C1")).toMatchObject({ quotes: 2, won: 1, lost: 1, countConversionPct: 50, valueConversionPct: 40 });
    expect(by(r.byCustomer, "C2").valueConversionPct).toBeCloseTo(79.996, 3); // 200050 / 250075
    expect(by(r.byCustomer, "C3")).toMatchObject({ quotes: 2, open: 1, unclassified: 1, closed: 0, countConversionPct: null, valueConversionPct: null });
  });
  it("a quote with no representative goes to an explicit (unassigned) group", () => {
    const r = run([{ no: "1", status: "won", so: "S", rep: null }, { no: "2", status: "lost", reason: "x", rep: "  " }, { no: "3", status: "won", so: "T", rep: "R9" }]);
    expect(r.byRep.map((g) => g.key)).toEqual(["R9", "(unassigned)"]);
    expect(by(r.byRep, "(unassigned)").quotes).toBe(2);
    expect(r.issues.rep_missing).toBe(2);
  });
  it("the representative on the quote is used; the customer master rep is not substituted, only counted when it conflicts", () => {
    const r = run([{ no: "1", status: "won", so: "S", customer: "C1", rep: null }, { no: "2", status: "won", so: "T", customer: "C1", rep: "R2" }], {}, { customers: [{ customer: "C1", rep: "R1" }] });
    expect(by(r.byRep, "(unassigned)").quotes).toBe(1);
    expect(r.issues.rep_conflict).toBe(1);
  });
  it("flags a customer that is not in the Customers tab (when the tab has rows)", () => {
    const r = run([{ no: "1", status: "open", customer: "C1" }, { no: "2", status: "open", customer: "ZZ" }], {}, { customers: [{ customer: "c1" }] });
    expect(r.issues.customer_not_in_master).toBe(1);
    expect(r.records.map((q) => q.customerKnown)).toEqual([true, false]);
    expect(run([{ no: "1", status: "open" }]).issues.customer_not_in_master).toBe(0);
  });
  it("groups by period using the quote date, by month, quarter or year", () => {
    const m = ref();
    expect(m.dateField).toBe("Quote date");
    expect(m.byPeriod.map((g) => g.key)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(by(m.byPeriod, "2026-01")).toMatchObject({ won: 2, closed: 2, countConversionPct: 100 });
    expect(by(m.byPeriod, "2026-02")).toMatchObject({ lost: 2, closed: 2, countConversionPct: 0 });
    expect(by(m.byPeriod, "2026-03").countConversionPct).toBeNull();
    const q = run(REFERENCE, { grain: "quarter" });
    expect(q.byPeriod.map((g) => g.key)).toEqual(["2026-Q1"]);
    expect(q.byPeriod[0].quotes).toBe(6);
    const y = run([{ no: "1", status: "open", date: "2025-12-31" }, { no: "2", status: "open", date: "2026-01-01" }], { grain: "year" });
    expect(y.byPeriod.map((g) => g.key)).toEqual(["2025", "2026"]);
  });
  it("period keys: month, quarter and year boundaries", () => {
    expect(periodKey("2026-03-31", "quarter")).toBe("2026-Q1");
    expect(periodKey("2026-04-01", "quarter")).toBe("2026-Q2");
    expect(periodKey("2026-12-31", "quarter")).toBe("2026-Q4");
    expect(periodKey("2026-01-01", "month")).toBe("2026-01");
    expect(periodKey("2026-12-31", "year")).toBe("2026");
    expect(periodKey(null, "month")).toBe("(no date)");
  });
  it("undated quotes get an explicit (no date) period and are flagged", () => {
    const r = run([{ no: "1", status: "won", so: "S", date: null }, { no: "2", status: "open", date: "2026-05-02" }]);
    expect(r.byPeriod.map((g) => g.key)).toEqual(["2026-05", "(no date)"]);
    expect(r.issues.date_missing).toBe(1);
  });
  it("period filter boundaries are inclusive on both ends, and undated quotes are excluded (and counted) when a range is set", () => {
    const specs: QSpec[] = [
      { no: "a", status: "open", date: "2026-01-31" },
      { no: "b", status: "open", date: "2026-02-01" },
      { no: "c", status: "open", date: "2026-02-28" },
      { no: "d", status: "open", date: "2026-03-01" },
      { no: "e", status: "open", date: null },
    ];
    const r = run(specs, { from: "2026-02-01", to: "2026-02-28" });
    expect(r.records.map((q) => q.ref)).toEqual(["b", "c"]);
    expect(r.filtered).toMatchObject({ total: 5, shown: 2, undatedExcluded: 1 });
    expect(run(specs, { from: "2026-02-01" }).records.map((q) => q.ref)).toEqual(["b", "c", "d"]);
    expect(run(specs, { to: "2026-02-01" }).records.map((q) => q.ref)).toEqual(["a", "b"]);
    expect(run(specs).records).toHaveLength(5);
  });
  it("representative and customer filters narrow every table", () => {
    const r = run(REFERENCE, { rep: "R2" });
    expect(r.total).toMatchObject({ quotes: 3, lost: 2, open: 1 });
    expect(r.byRep.map((g) => g.key)).toEqual(["R2"]);
    const c = run(REFERENCE, { customer: "C3" });
    expect(c.total.quotes).toBe(2);
    expect(c.options.reps).toEqual(["R1", "R2"]); // options always come from the whole data set
  });
  it("group totals reconcile to the overall totals on every dimension", () => {
    const r = ref();
    for (const rows of [r.byRep, r.byCustomer, r.byPeriod]) {
      expect(sumOf(rows, (m) => m.quotes)).toBe(r.total.quotes);
      expect(sumOf(rows, (m) => m.won)).toBe(r.total.won);
      expect(sumOf(rows, (m) => m.lost)).toBe(r.total.lost);
      expect(sumOf(rows, (m) => m.open)).toBe(r.total.open);
      expect(sumOf(rows, (m) => m.unclassified)).toBe(r.total.unclassified);
      expect(sumOf(rows, (m) => m.wonCents)).toBe(r.total.wonCents);
      expect(sumOf(rows, (m) => m.lostCents)).toBe(r.total.lostCents);
      expect(sumOf(rows, (m) => m.openCents)).toBe(r.total.openCents);
    }
    expect(r.checks.every((c) => c.pass)).toBe(true);
    expect(r.checks.map((c) => c.code)).toEqual(expect.arrayContaining(["rep", "customer", "period", "reasons", "product"]));
  });
  it("reconciliation holds on a larger mixed set, and a broken invariant would be reported", () => {
    const specs: QSpec[] = Array.from({ length: 60 }, (_, i) => ({
      no: `Q${i}`, customer: `C${i % 7}`, rep: i % 11 === 0 ? null : `R${i % 4}`, status: ["won", "lost", "open", "weird"][i % 4],
      value: (i * 137.37) % 5000, reason: i % 4 === 1 ? `Reason ${i % 3}` : null, so: i % 4 === 0 ? `SO-${i}` : null, date: i % 13 === 0 ? null : `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 27) + 1).padStart(2, "0")}`,
    }));
    const r = run(specs);
    for (const rows of [r.byRep, r.byCustomer, r.byPeriod]) {
      expect(sumOf(rows, (m) => m.quotes)).toBe(60);
      expect(sumOf(rows, (m) => m.wonCents)).toBe(r.total.wonCents);
      expect(sumOf(rows, (m) => m.closedCents)).toBe(r.total.closedCents);
    }
    expect(r.checks.every((c) => c.pass)).toBe(true);
  });
});

describe("win/loss by reason", () => {
  it("groups lost reasons by count and value, merging case and spacing variants, keeping the first spelling", () => {
    const r = ref();
    expect(r.reasons.rows).toEqual([{ key: "price", reason: "Price", count: 2, cents: 200025 }]);
    expect(r.reasons.complete).toBe(true);
    expect(r.reasons.lostCount).toBe(2);
  });
  it("orders reasons by count then name, and reasons plus missing equal the lost quotes", () => {
    const r = run([
      { no: "1", status: "lost", reason: "Lead time", value: 10 }, { no: "2", status: "lost", reason: "Price", value: 20 }, { no: "3", status: "lost", reason: "Price", value: 30 },
      { no: "4", status: "lost", reason: "Competitor", value: 5 }, { no: "5", status: "lost", value: 7 },
    ]);
    expect(r.reasons.rows.map((x) => `${x.reason}:${x.count}:${x.cents}`)).toEqual(["Price:2:5000", "Competitor:1:500", "Lead time:1:1000"]);
    expect(r.reasons.rows.reduce((a, x) => a + x.count, 0) + r.reasons.missing.count).toBe(r.total.lost);
    expect(r.reasons.rows.reduce((a, x) => a + x.cents, 0) + r.reasons.missing.cents).toBe(r.total.lostCents);
  });
  it("only LOST quotes appear in the reasons", () => {
    const r = run([{ no: "1", status: "won", so: "S", reason: "should be ignored" }, { no: "2", status: "open", reason: "ignored" }]);
    expect(r.reasons.rows).toEqual([]);
    expect(r.reasons.lostCount).toBe(0);
  });
});

describe("product analysis", () => {
  it("is available only when quotes carry a product; otherwise withheld with a reason", () => {
    const r = run([{ no: "1", status: "won", so: "S", product: null }]);
    expect(r.byProduct.available).toBe(false);
    expect(r.byProduct.rows).toEqual([]);
    expect(r.byProduct.reason).toMatch(/no product/i);
  });
  it("counts a quote once per product it features (count basis) and keeps overall totals once per quote", () => {
    const r = ref();
    expect(r.byProduct.available).toBe(true);
    expect(r.byProduct.rows.map((p) => p.key)).toEqual(["P1", "P2"]);
    expect(by(r.byProduct.rows, "P1")).toMatchObject({ quotes: 4, won: 2, lost: 1, open: 0, unclassified: 1, closed: 3 });
    expect(by(r.byProduct.rows, "P1").countConversionPct).toBeCloseTo(66.6667, 3);
    expect(by(r.byProduct.rows, "P2")).toMatchObject({ quotes: 3, won: 0, lost: 2, open: 1, closed: 2, countConversionPct: 0 });
    expect(r.total.quotes).toBe(6); // Q4 is in both products but counted once overall
    expect(r.byProduct.multiProductQuotes).toBe(1);
  });
  it("value metrics use only single-product quotes; multi-product quote values are withheld, not split", () => {
    const r = ref();
    const p1 = by(r.byProduct.rows, "P1");
    expect(p1).toMatchObject({ soleQuotes: 3, wonCents: 300050, lostCents: 0, valueConversionPct: 100, sharedClosed: 1 });
    const p2 = by(r.byProduct.rows, "P2");
    expect(p2).toMatchObject({ soleQuotes: 2, wonCents: 0, lostCents: 150000, valueConversionPct: 0, sharedClosed: 1 });
    expect(r.byProduct.valueNote).toMatch(/not split|withheld/i);
  });
  it("sole-product + multi-product + no-product quotes account for every quote", () => {
    const r = run([...REFERENCE, { no: "Q7", status: "open", product: null }]);
    const sole = r.byProduct.rows.reduce((a, p) => a + p.soleQuotes, 0);
    expect(sole + r.byProduct.multiProductQuotes + r.byProduct.noProductQuotes).toBe(r.total.quotes);
    expect(r.byProduct.noProductQuotes).toBe(1);
    expect(r.checks.find((c) => c.code === "product")?.pass).toBe(true);
  });
  it("a product listed twice in one quote is counted once; separators are ; | and new line, not comma", () => {
    const r = run([{ no: "1", status: "won", so: "S", product: "P1; p1 ;P1" }, { no: "2", status: "lost", reason: "x", product: "P1|P2\nP3" }, { no: "3", status: "open", product: "A, B" }]);
    expect(by(r.byProduct.rows, "P1")).toMatchObject({ quotes: 2, soleQuotes: 1 });
    expect(r.byProduct.rows.map((p) => p.key)).toEqual(["A, B", "P1", "P2", "P3"]);
  });
  it("the product filter selects the quotes that feature the product", () => {
    const r = run(REFERENCE, { product: "P2" });
    expect(r.records.map((q) => q.ref)).toEqual(["Q3", "Q4", "Q5"]);
    expect(r.total.quotes).toBe(3);
  });
  it("checks product references against Items when Items exist, and says so when they do not match", () => {
    const r = run([{ no: "1", status: "open", product: "P1" }, { no: "2", status: "open", product: "ZZ" }], {}, { styles: ["P1"] });
    expect(r.issues.product_unmatched).toBe(1);
    expect(by(r.byProduct.rows, "ZZ").inItems).toBe(false);
    expect(by(r.byProduct.rows, "P1").inItems).toBe(true);
    expect(run([{ no: "1", status: "open", product: "ZZ" }]).issues.product_unmatched).toBe(0);
  });
  it("quotes without a product are listed as such and mark the product analysis partial", () => {
    const r = run([{ no: "1", status: "open", product: "P1" }, { no: "2", status: "open", product: null }]);
    expect(r.byProduct.noProductQuotes).toBe(1);
    expect(r.byProduct.partial).toBe(true);
  });
});

describe("options, assumptions and determinism", () => {
  it("lists the filter options from the whole data set", () => {
    const r = ref();
    expect(r.options).toMatchObject({ reps: ["R1", "R2"], customers: ["C1", "C2", "C3"], products: ["P1", "P2"] });
  });
  it("states the assumptions that matter, including the date used and the closed-date gap", () => {
    const t = ref().assumptions.map((a) => a.text).join(" ");
    expect(t).toMatch(/quote date/i);
    expect(t).toMatch(/closed|won or lost/i);
    expect(t).toMatch(/status/i);
  });
  it("is deterministic and does not mutate the dataset", () => {
    const ds = quoteDataset(REFERENCE);
    const before = JSON.stringify(ds.tables.quotes);
    expect(JSON.stringify(runQuoteConversion(ds))).toBe(JSON.stringify(runQuoteConversion(ds)));
    expect(JSON.stringify(ds.tables.quotes)).toBe(before);
  });
  it("an empty quote table gives an empty, not-complete-claimed result", () => {
    const r = run([]);
    expect(r.total.quotes).toBe(0);
    expect(r.byRep).toEqual([]);
    expect(r.completeness.complete).toBe(false);
    expect(r.completeness.reasons.join(" ")).toMatch(/no quotes/i);
  });
});

describe("the reconciliation check can actually fail", () => {
  it("reconcileGroups is true for consistent groups and false when any total is off by one", () => {
    const r = ref();
    expect(reconcileGroups(r.byRep, r.total)).toBe(true);
    const tweaks: Partial<Metrics>[] = [{ quotes: 1 }, { won: 1 }, { lost: 1 }, { open: 1 }, { unclassified: 1 }, { wonCents: 1 }, { lostCents: 1 }, { openCents: 1 }, { unclassifiedCents: 1 }];
    for (const t of tweaks) {
      const bad = r.byRep.map((g, i) => (i === 0 ? { ...g, ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, (g as unknown as Record<string, number>)[k] + (v as number)])) } : g));
      expect(reconcileGroups(bad, r.total), JSON.stringify(t)).toBe(false);
    }
    expect(reconcileGroups([], r.total)).toBe(false);
    const ok = groupCheck("rep", "label", r.byRep, r.total);
    expect(ok).toMatchObject({ code: "rep", pass: true });
    expect(ok.detail).toContain("6 of 6 quotes");
    const dropped = groupCheck("rep", "label", r.byRep.slice(1), r.total);
    expect(dropped.pass).toBe(false);
    expect(dropped.detail).toContain("3 of 6 quotes");
  });
});
