// PROVISIONAL BUDGET PRICING (owner decision 2026-11-18, UAT only). NQ-Q-0002's saved configuration is used as a READ-ONLY regression fixture (rebuilt in memory: nothing here reads or writes the database).
// The expected figures are measurements of the current saved configuration under the current UAT assumptions (test-only freight 1.15, markup 20%): they are NOT approved prices.
import { describe, expect, it } from "vitest";
import type { QuoteDraft } from "../draft";
import { evaluateDraft } from "../evaluate";
import { budgetPricingOf } from "../budget-pricing";
import { packageFor, provisionalPackageBasis } from "../commercial";
import { createWorkbookPriceSource } from "../workbook-price-source";
import { NEWQUIP_MASTER_POC_SNAPSHOT } from "../snapshot";
import { attributeVariance, VARIANCE_STEPS } from "@/newquip/pricing/budget-variance";

const ctx = (provisional: boolean, withholdCost = true) => ({ priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost, provisionalPackages: provisional });
import { nqQ0002, S } from "./nq-q-0002-fixture";
const lineOf = (d: QuoteDraft, provisional: boolean, k: string) => evaluateDraft(d, ctx(provisional)).budget!.lines.find((l) => l.itemKey === k)!;

describe("eligibility (existing template logic; never a confirmation)", () => {
  it("the cup-drinker and LED packages qualify, with internal reasons and the composition", () => {
    for (const k of ["cup_drinker", "led_light"] as const) {
      const b = provisionalPackageBasis(packageFor(k, "grower-2026-11"))!;
      expect(b, k).not.toBeNull();
      expect(b.internalReasons.length).toBeGreaterThan(0);
      expect(b.qualifies).toMatch(/NOT a NewQuip-approved specification/);
      expect(b.plain).toMatch(/^Provisional:/);
    }
    expect(provisionalPackageBasis(packageFor("cup_drinker", "grower-2026-11"))!.composition).toEqual([{ sku: "QCA00003", qtyPerUnit: 1 }, { sku: "NQ1380", qtyPerUnit: 1 }, { sku: "NQ2784", qtyPerUnit: 1 }, { sku: "NQ2886", qtyPerUnit: 1 }, { sku: "NQ1386", qtyPerUnit: 5 }, { sku: "NYNUT", qtyPerUnit: 5 }, { sku: "NQ1017", qtyPerUnit: 5 }]);
    expect(provisionalPackageBasis(packageFor("led_light", "grower-2026-11"))!.composition).toEqual([{ sku: "HNQ7046", qtyPerUnit: 1 }, { sku: "HNQ7093", qtyPerUnit: 3 }, { sku: "HNQ7088", qtyPerUnit: 1 }]);
  });
  it("the cup drinker's open alternative (NB3542-03) and the LED's naming question stay in the INTERNAL reasons", () => {
    expect(provisionalPackageBasis(packageFor("cup_drinker", "grower-2026-11"))!.internalReasons.join(" ")).toMatch(/NB3542-03/);
    expect(provisionalPackageBasis(packageFor("led_light", "grower-2026-11"))!.internalReasons.join(" ")).toMatch(/FORTIS/);
  });
  it("nothing else qualifies: the M75 (estimator-priced / layout-driven) and the PVC door never do", () => {
    expect(provisionalPackageBasis(packageFor("flex_auger", "grower-2026-11"))).toBeNull();
    expect(provisionalPackageBasis(undefined)).toBeNull();
  });
});

describe("NQ-Q-0002 regression fixture (read-only)", () => {
  const d = nqQ0002();
  it("DEFAULT engine is unchanged: subtotal R10,365,332.64, LED and drinkers still await the Estimator, no provisional marker anywhere", () => {
    const b = evaluateDraft(d, ctx(false)).budget!;
    expect(b.totals.subtotalExTax).toBeCloseTo(10_365_332.64, 2);
    expect(b.lines.find((l) => l.itemKey === "cup_drinker")!.status).toBe("package_unconfirmed");
    expect(b.lines.find((l) => l.itemKey === "led_light")!.status).toBe("package_unconfirmed");
    expect(b.lines.some((l) => l.provisional)).toBe(false);
  });
  it("BUDGET evaluation: drinkers R431,082.00, LED R332,934.72, provisional subtotal R11,129,349.36; PVC doors stay unpriced", () => {
    const dr = lineOf(d, true, "cup_drinker"), led = lineOf(d, true, "led_light"), door = lineOf(d, true, "pvc_door");
    expect(dr.revenueExTax).toBeCloseTo(431_082.0, 2);
    expect(led.revenueExTax).toBeCloseTo(332_934.72, 2);
    expect(dr.provisional?.plain).toMatch(/^Provisional/);
    expect(led.provisional).toBeDefined();
    expect(door.status).toBe("unmapped");
    expect(evaluateDraft(d, ctx(true)).budget!.totals.subtotalExTax).toBeCloseTo(11_129_349.36, 2);
  });
  it("the summary: 2 provisional, 1 unpriced, a priced SUBTOTAL and NO estimated total while PVC doors are unpriced", () => {
    const v = budgetPricingOf(evaluateDraft(d, ctx(true)).budget!);
    expect(v.counts).toMatchObject({ provisional: 2, unpriced: 1 });
    expect(v.subtotalExVat).toBeCloseTo(11_129_349.36, 2);
    expect(v.estimatedTotalExVat).toBeNull();
    expect(v.estimatedTotalIncVat).toBeNull();
    expect(v.provisionalValueExVat).toBeCloseTo(764_016.72, 2);
    expect(v.unpricedItems.join(" ")).toMatch(/PVC SST door/);
  });
  it("REP-SAFE: nothing in the summary (or the Rep's evaluation) carries a supplier, SKU, cost, rate, freight, markup or margin", () => {
    const v = JSON.stringify(budgetPricingOf(evaluateDraft(d, ctx(true)).budget!));
    expect(v).not.toMatch(/HNQ|QCA|NQ1380|NYNUT|supplier|freight|markup|margin|landed|rateMicro|nativeUnitCost|costKind/i);
    const lines = evaluateDraft(d, ctx(true)).budget!.lines;
    expect(lines.every((l) => l.estimatedCost === null && l.estimatedGP === null && l.marginPct === null)).toBe(true);
    expect(JSON.stringify(lines.map((l) => l.provisional))).not.toMatch(/HNQ|QCA|supplier|NB3542|FORTIS/i);
  });
  it("PROVISIONAL NEVER CONFIRMS ANYTHING: readiness, sign-off gates and the saved draft still say the packages await the Estimator", () => {
    const base = evaluateDraft(d, ctx(false));
    expect(base.readiness.state).not.toBe("READY");
    expect(base.budget!.blockers.join(" ")).toMatch(/package awaiting confirmation/);
    expect(d.estimator.confirmedPackages).toEqual([]);
  });
  it("a package with a MISSING component cost is NOT priced even provisionally (never guess a cost)", () => {
    const x = structuredClone(d); delete (x.estimator.pricing!.skus as Record<string, unknown>).HNQ7093;
    const led = lineOf(x, true, "led_light");
    expect(led.status).not.toBe("priced");
    expect(led.provisional).toBeUndefined();
    expect(lineOf(x, true, "cup_drinker").status).toBe("priced");
  });
  it("an Estimator-CONFIRMED package is simply priced: no provisional marker", () => {
    const x = structuredClone(d); x.estimator.confirmedPackages = ["cup_drinker"] as never;
    const dr = lineOf(x, true, "cup_drinker");
    expect(dr.status).toBe("priced"); expect(dr.provisional).toBeUndefined();
  });
  it("a COMPLETE budget (door mapped and costed) shows an estimated total, labelled provisional while provisional lines remain", () => {
    const x = structuredClone(d); x.estimator.confirmedMappings = { pvc_door: "NQ3444" } as never; (x.estimator.pricing!.skus as Record<string, unknown>).NQ3444 = S("ZAR", 90000000000);
    const v = budgetPricingOf(evaluateDraft(x, ctx(true)).budget!);
    expect(v.counts.unpriced).toBe(0);
    expect(v.estimatedTotalExVat).not.toBeNull(); expect(v.totalBasis).toBe("provisional");
    expect(v.estimatedTotalIncVat!).toBeCloseTo(v.estimatedTotalExVat! * 1.15, 0);
  });
});

describe("variance attribution (existing engine, step by step; steps sum exactly to the difference)", () => {
  const budget = nqQ0002();
  const final = () => { const x = structuredClone(budget); x.estimator.confirmedPackages = ["cup_drinker", "led_light"] as never; return x; };
  const run = (f: QuoteDraft) => attributeVariance(budget, f, { priceSource: createWorkbookPriceSource(NEWQUIP_MASTER_POC_SNAPSHOT), withholdCost: false });
  const sum = (r: ReturnType<typeof run>) => VARIANCE_STEPS.reduce((a, s) => a + r.totals.byStep[s], 0);

  it("confirming the packages with NO input changed leaves the amount unchanged: the Budget price already equals the verified price (zero variance)", () => {
    const r = run(final());
    expect(r.totals.deltaExVat).toBeCloseTo(0, 2);
    for (const s of VARIANCE_STEPS) expect(r.totals.byStep[s], s).toBeCloseTo(0, 2);
  });
  it("a corrected specification (a quantity per room changed by the Estimator) is attributed to SPECIFICATION only", () => {
    const f = final(); f.config.estimatorQuantities = { ...f.config.estimatorQuantities, cup_drinker: 60 };
    const r = run(f);
    expect(r.totals.byStep.specification).toBeGreaterThan(0);
    for (const s of ["supplier_costs", "fx", "freight", "markup", "other"] as const) expect(r.totals.byStep[s], s).toBeCloseTo(0, 2);
    expect(sum(r)).toBeCloseTo(r.totals.deltaExVat, 2);
  });
  it("a product that was UNPRICED in the budget and gets a mapping plus new supplier evidence appears under SUPPLIER COSTS (new evidence), and the steps still add up", () => {
    const f = final(); f.estimator.confirmedMappings = { pvc_door: "NQ3444" } as never; (f.estimator.pricing!.skus as Record<string, unknown>).NQ3444 = S("ZAR", 90000000000);
    const r = run(f);
    expect(r.totals.byStep.supplier_costs).toBeGreaterThan(0);
    expect(sum(r)).toBeCloseTo(r.totals.deltaExVat, 2);
    expect(r.lines.find((l) => l.key === "pvc_door")!.budgetStatus).toBe("unmapped");
  });
  it("an exchange-rate change is attributed to FX only", () => {
    const f = final(); f.estimator.pricing!.fxQuotes.EUR = { asOf: "2026-11-17T12:00:00Z", source: "OXR", rateMicro: 20_000_000 };
    const r = run(f);
    expect(r.totals.byStep.fx).toBeGreaterThan(0);
    for (const s of ["supplier_costs", "freight", "markup", "other"] as const) expect(r.totals.byStep[s], s).toBeCloseTo(0, 2);
    expect(sum(r)).toBeCloseTo(r.totals.deltaExVat, 2);
  });
  it("a supplier cost change, a freight change, a markup change and a charge change each land in their own step; the steps add up exactly", () => {
    const f = final();
    (f.estimator.pricing!.skus as Record<string, { nativeUnitCostE7: number; freight: { factorMicro: number } }>).HNQ7046.nativeUnitCostE7 = 300000000;
    (f.estimator.pricing!.skus as Record<string, { nativeUnitCostE7: number; freight: { factorMicro: number } }>).NQ1380.freight.factorMicro = 1300000;
    f.estimator.pricing!.projectMarkup = { ...f.estimator.pricing!.projectMarkup!, markupBps: 2500 };
    f.estimator.charges = { ...f.estimator.charges, delivery: 20000 };
    const r = run(f);
    expect(r.totals.byStep.supplier_costs).toBeGreaterThan(0);
    expect(r.totals.byStep.freight).toBeGreaterThan(0);
    expect(r.totals.byStep.markup).toBeGreaterThan(0);
    expect(r.totals.byStep.other).toBeCloseTo(5000, 2);
    expect(sum(r)).toBeCloseTo(r.totals.deltaExVat, 2);
    expect(r.lines.every((l) => Math.abs(VARIANCE_STEPS.reduce((a, s) => a + l.byStep[s], 0) - l.deltaExVat) < 0.02)).toBe(true);
  });
  it("identical drafts have no variance", () => expect(run(structuredClone(budget)).totals.deltaExVat).toBe(0));
});
