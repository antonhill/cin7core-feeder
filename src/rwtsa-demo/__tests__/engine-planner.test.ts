import { describe, expect, it } from "vitest";
import { runRedFlag } from "@/rwtsa-demo/engine";
import { shiftDays } from "@/rwtsa-demo/engine/calendar";
import { LOCAL_MAKE_LABEL, localMakeOffset, validateLocalMake, type LocalMakeEntry } from "@/rwtsa-demo/engine/local-make";
import { makeDataset, type SkuSpec } from "./engine-fixture";

/** DP-14, DP-15, DP-16, DP-19 at engine level. Synthetic, hand-checkable. Stock date 2026-10-31; weekly forecast = monthly / 4.345. */
const flat = (n: number, len = 6): number[] => Array.from({ length: len }, () => n);
const run = (skus: SkuSpec[], cfg = {}) => runRedFlag(makeDataset({ skus }), { historyAnchor: "last-available", ...cfg });
const only = (r: ReturnType<typeof run>) => r.skus[0];
const STOCK = "2026-10-31";

describe("DP-16: tender classification", () => {
  it("resolves planner > workbook > unclassified, and says where each came from", () => {
    const r = run([
      { sku: "N", tender: null, sales: flat(10) },
      { sku: "T", tender: true, sales: flat(10) },
      { sku: "O", tender: false, sales: flat(10) },
      { sku: "P", tender: false, sales: flat(10) },
    ], { planner: { classification: { P: "tender" }, minOverrides: {} } });
    const by = Object.fromEntries(r.skus.map((s) => [s.sku, [s.classification, s.classificationSource]]));
    expect(by).toEqual({ N: ["unclassified", "none"], T: ["tender", "workbook"], O: ["ordinary", "workbook"], P: ["tender", "planner"] });
    expect(r.summary.unclassifiedSkus).toBe(1);
  });
  it("an unclassified SKU keeps its demand and shortfall; only its proposal is held back (not counted in totals)", () => {
    const s = only(run([{ sku: "U", tender: null, minLevel: 50, jhb: 20, sales: flat(40) }]));
    expect(s.monthlyForecast).toBe(40);
    expect(s.shortfall).toBeGreaterThan(0);
    expect(s.firstBreachWeek).toBe(1);
    expect(s.proposedOrder).toBe(0);
    expect(s.tenderExempt).toBe(false);
  });
  it("a tender SKU keeps its history and projected risk, proposes nothing, and never uses the workbook minimum as a standing minimum", () => {
    const poor = only(run([{ sku: "T", tender: true, minLevel: 500, jhb: 30, sales: flat(40) }]));
    expect(poor.monthlyForecast).toBe(40);
    expect(poor.proposedOrder).toBe(0);
    expect(poor.proposalCalculated).toBe(0);
    // risk = stock-out below ZERO: 30 on hand, ~9.2/week -> negative in week 4
    expect(poor.firstBreachWeek).toBe(4);
    expect(poor.shortfall).toBeGreaterThan(0);
    const rich = only(run([{ sku: "T", tender: true, minLevel: 500, jhb: 1000, sales: flat(40) }]));
    expect(rich.firstBreachWeek).toBeNull();
    expect(rich.shortfall).toBe(0);
  });
  it("tender stock-out risk is counted separately and does not enter the standing shortage totals", () => {
    const r = run([{ sku: "T", tender: true, jhb: 0, sales: flat(40) }, { sku: "O", tender: false, minLevel: 100, jhb: 0, sales: flat(40) }]);
    expect(r.summary.tenderStockoutSkus).toBe(1);
    expect(r.summary.shortageSkus).toBe(1);
    expect(r.summary.totalShortfall).toBe(r.skus.find((s) => s.sku === "O")!.shortfall);
    expect(r.styles[0].shortfall).toBe(r.skus.find((s) => s.sku === "O")!.shortfall);
  });
  it("one-off tender demand is still caught by the anomaly rule and can be excluded", () => {
    const sales = [10, 10, 10, 10, 10, 400];
    const base = runRedFlag(makeDataset({ skus: [{ sku: "T", tender: true, jhb: 50, sales }] }), { historyAnchor: "last-available" });
    expect(base.anomalies.map((a) => a.month)).toEqual(["2026-08"]);
    const ex = runRedFlag(makeDataset({ skus: [{ sku: "T", tender: true, jhb: 50, sales }] }), { historyAnchor: "last-available" }, [{ sku: "T", month: "2026-08", reason: "tender" }]);
    expect(ex.skus[0].monthlyForecast).toBe(10);
  });
  it("reclassifying changes eligibility without touching demand", () => {
    const base = { sku: "A", tender: null as boolean | null, minLevel: 50, jhb: 20, sales: flat(40) };
    const a = only(run([base], { planner: { classification: { A: "ordinary" }, minOverrides: {} } }));
    const b = only(run([base], { planner: { classification: { A: "tender" }, minOverrides: {} } }));
    expect(a.proposedOrder).toBeGreaterThan(0);
    expect(b.proposedOrder).toBe(0);
    expect(a.monthlyForecast).toBe(b.monthlyForecast);
  });
});

describe("DP-19: temporary minimum override", () => {
  const sku: SkuSpec = { sku: "A", tender: false, minLevel: 10, jhb: 100, sales: flat(40) };
  const ov = (o: { replacement: number; effectiveFrom: string; expires: string | null }) => ({ planner: { classification: {}, minOverrides: { A: o } } });
  it("keeps the original minimum, shows the effective one, and recalculates the shortfall", () => {
    const base = only(run([sku]));
    const s = only(run([sku], ov({ replacement: 90, effectiveFrom: STOCK, expires: null })));
    expect(s.minLevel).toBe(10); // the workbook's value is never overwritten
    expect(s.effectiveMin).toBe(90);
    expect(s.minOverrideWeeks).toBe(13);
    expect(s.shortfall).toBeGreaterThan(base.shortfall);
    expect(s.firstBreachWeek as number).toBeLessThan(base.firstBreachWeek ?? 99);
    expect(s.proposedOrder).toBeGreaterThan(base.proposedOrder);
  });
  it("removing it restores the original result exactly", () => {
    const base = only(run([sku]));
    const restored = only(run([sku], { planner: { classification: {}, minOverrides: {} } }));
    expect(restored).toEqual(base);
    expect(restored.effectiveMin).toBe(10);
    expect(restored.minOverride).toBeNull();
  });
  it("effective date: it applies from the week whose closing date is on or after it", () => {
    const wk3 = shiftDays(STOCK, 21);
    const wk4 = shiftDays(STOCK, 28);
    expect(only(run([sku], ov({ replacement: 90, effectiveFrom: wk3, expires: null }))).minOverrideWeeks).toBe(11); // weeks 3..13
    expect(only(run([sku], ov({ replacement: 90, effectiveFrom: shiftDays(wk3, 1), expires: null }))).minOverrideWeeks).toBe(10); // starts the day after week 3 closes: weeks 4..13
    expect(only(run([sku], ov({ replacement: 90, effectiveFrom: wk4, expires: null }))).effectiveMin).toBe(10); // not yet in force at the stock date
  });
  it("expiry: inclusive on the closing date of its last week, then the original minimum applies again", () => {
    const from = shiftDays(STOCK, 7);
    const until = shiftDays(STOCK, 35); // end of week 5
    expect(only(run([sku], ov({ replacement: 90, effectiveFrom: from, expires: until }))).minOverrideWeeks).toBe(5); // weeks 1..5
    expect(only(run([sku], ov({ replacement: 90, effectiveFrom: from, expires: shiftDays(until, -1) }))).minOverrideWeeks).toBe(4);
  });
  it("an override can lower the minimum, and can supply one where the workbook has none", () => {
    const rich = { ...sku, minLevel: 950, jhb: 1000 };
    expect(only(run([rich])).shortfall).toBeGreaterThan(0);
    expect(only(run([rich], ov({ replacement: 0, effectiveFrom: STOCK, expires: null }))).shortfall).toBe(0);
    const none = only(run([{ ...sku, minLevel: null }]));
    expect(none.limitation).toMatch(/No minimum stock level/);
    const given = only(run([{ ...sku, minLevel: null }], ov({ replacement: 90, effectiveFrom: STOCK, expires: null })));
    expect(given.minLevel).toBeNull();
    expect(given.effectiveMin).toBe(90);
    expect(given.shortfall).toBeGreaterThan(0);
  });
  it("is validated: a negative replacement, a bad date or an expiry before the start is rejected", () => {
    expect(() => run([sku], ov({ replacement: -1, effectiveFrom: STOCK, expires: null }))).toThrow(/replacement/);
    expect(() => run([sku], ov({ replacement: 5, effectiveFrom: "31/10/2026", expires: null }))).toThrow(/dates/);
    expect(() => run([sku], ov({ replacement: 5, effectiveFrom: STOCK, expires: shiftDays(STOCK, -1) }))).toThrow(/expires before/);
  });
});

describe("DP-15: the calculated proposal follows the selected, labelled formula", () => {
  const sku: SkuSpec = { sku: "A", tender: false, minLevel: 20, jhb: 50, sales: flat(100) };
  it("default is the approved minimum-shortfall rule; net-requirement switches the calculated figure only", () => {
    const a = only(run([sku]));
    const n = only(run([sku], { replenishmentFormula: "net-requirement" }));
    expect(a.proposalFormula).toBe("minimum-shortfall");
    expect(a.proposalCalculated).toBe(270);
    expect(n.proposalFormula).toBe("net-requirement");
    expect(n.proposalCalculated).toBe(250);
    expect(n.proposedOrder).toBe(250);
    expect(n.shortfall).toBe(a.shortfall); // the projected risk is a separate output and does not change
    expect(() => run([sku], { replenishmentFormula: "x" as never })).toThrow(/formula/i);
  });
  it("a tender SKU is 0 under either formula and an unclassified SKU has no proposal under either", () => {
    for (const f of ["minimum-shortfall", "net-requirement"] as const) {
      expect(only(run([{ ...sku, tender: true }], { replenishmentFormula: f })).proposedOrder).toBe(0);
      expect(only(run([{ ...sku, tender: null }], { replenishmentFormula: f })).proposedOrder).toBe(0);
    }
  });
});

describe("DP-14: local make offset", () => {
  const entry: LocalMakeEntry = { quantity: 100, capacityUnits: 100, leadTimeWeeks: 3, completionWeek: 4 };
  const input = (o: Partial<Parameters<typeof localMakeOffset>[0]> = {}) => ({ gross: 250, source: "Both" as string | null, eligible: true, entry: entry as LocalMakeEntry | null, horizonWeeks: 13, ...o });
  it("is NOT EVALUATED without data: nothing is invented, and no figure is shown", () => {
    const r = localMakeOffset(input({ entry: null }));
    expect(r.status).toBe("NOT EVALUATED");
    expect(r.reason).toMatch(/not in the workbook, and none is invented/);
    expect(r.localCounted).toBe(0);
    expect(r.residualImport).toBeNull();
    expect(r.label).toBeNull();
  });
  it("is NOT EVALUATED for a tender or unclassified SKU and when there is no requirement", () => {
    expect(localMakeOffset(input({ eligible: false })).status).toBe("NOT EVALUATED");
    expect(localMakeOffset(input({ gross: null })).status).toBe("NOT EVALUATED");
  });
  it("is BLOCKED for an import-only SKU", () => {
    const r = localMakeOffset(input({ source: "Import" }));
    expect(r.status).toBe("BLOCKED");
    expect(r.localCounted).toBe(0);
    expect(localMakeOffset(input({ source: "Local" })).status).toBe("EVALUATED");
    expect(localMakeOffset(input({ source: null })).status).toBe("EVALUATED");
  });
  it("shows gross, local make within the horizon, and the residual import requirement, labelled a demonstration assumption", () => {
    const r = localMakeOffset(input());
    expect([r.status, r.gross, r.localCounted, r.residualImport]).toEqual(["EVALUATED", 250, 100, 150]);
    expect(r.label).toBe(LOCAL_MAKE_LABEL);
    expect(r.label).toMatch(/not a client-confirmed value/);
  });
  it("is capped by capacity, and never offsets more than the requirement", () => {
    const cap = localMakeOffset(input({ entry: { ...entry, quantity: 200, capacityUnits: 60 } }));
    expect([cap.localCounted, cap.residualImport]).toEqual([60, 190]);
    expect(cap.reason).toMatch(/exceeds capacity/);
    const over = localMakeOffset(input({ gross: 40 }));
    expect([over.localCounted, over.residualImport]).toEqual([40, 0]);
    expect(over.reason).toMatch(/only the requirement is counted/);
  });
  it("lead-time boundary: completion in the lead-time week is allowed, the week before is BLOCKED", () => {
    expect(localMakeOffset(input({ entry: { ...entry, leadTimeWeeks: 4, completionWeek: 4 } })).status).toBe("EVALUATED");
    const early = localMakeOffset(input({ entry: { ...entry, leadTimeWeeks: 4, completionWeek: 3 } }));
    expect(early.status).toBe("BLOCKED");
    expect(early.reason).toMatch(/earlier than the production lead time/);
  });
  it("horizon boundary: completing in the last horizon week counts, one week later does not", () => {
    expect(localMakeOffset(input({ entry: { ...entry, completionWeek: 13 } })).localCounted).toBe(100);
    const late = localMakeOffset(input({ entry: { ...entry, completionWeek: 14 } }));
    expect(late.localCounted).toBe(0);
    expect(late.residualImport).toBe(250);
    expect(late.reason).toMatch(/after the 13-week horizon/);
    expect(localMakeOffset(input({ entry: { ...entry, completionWeek: 14 }, horizonWeeks: 26 })).localCounted).toBe(100);
  });
  it("rejects values that are not whole numbers in range", () => {
    expect(validateLocalMake(entry)).toBeNull();
    for (const bad of [{ quantity: -1 }, { quantity: 1.5 }, { capacityUnits: -5 }, { leadTimeWeeks: 53 }, { completionWeek: 0 }, { completionWeek: 53 }]) {
      expect(validateLocalMake({ ...entry, ...bad }), JSON.stringify(bad)).not.toBeNull();
      expect(localMakeOffset(input({ entry: { ...entry, ...bad } })).status).toBe("BLOCKED");
    }
  });
  it("never creates stock: the engine's balances, Available and inbound do not know about it", () => {
    const s = only(run([{ sku: "A", tender: false, minLevel: 50, jhb: 10, sales: flat(40) }]));
    const gross = s.proposalCalculated;
    localMakeOffset({ gross, source: "Both", eligible: true, entry, horizonWeeks: 13 });
    const again = only(run([{ sku: "A", tender: false, minLevel: 50, jhb: 10, sales: flat(40) }]));
    expect(again.balances).toEqual(s.balances);
    expect(again.available).toBe(s.available);
    expect(again.inboundTotal).toBe(s.inboundTotal);
  });
});
