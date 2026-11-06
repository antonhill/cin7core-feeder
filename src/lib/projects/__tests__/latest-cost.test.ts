import { describe, expect, it } from "vitest";
import { buildCostEstimate, physicalMargin, resolveLatestCost, validateManualEstimate, type CostEntry } from "../latest-cost";

const s = (cost: number | null, lastSupplied: string | null = null, supplier: string | null = "S", fixedCost: number | null = null) => ({ supplier, cost, fixedCost, lastSupplied });

describe("resolveLatestCost: Cin7 latest cost only, no hierarchy", () => {
  it("uses the most recently supplied supplier cost", () => {
    const r = resolveLatestCost([s(10, "2026-01-01", "A"), s(15, "2026-09-01", "B"), s(12, "2026-05-01", "C")]);
    expect(r).toMatchObject({ status: "LATEST", unitCostCents: 1500, supplier: "B", suppliersConsidered: 3 });
  });
  it("a single supplier cost is used even without a purchase date; cents are exact", () => {
    expect(resolveLatestCost([s(12.5)])).toMatchObject({ status: "LATEST", unitCostCents: 1250 });
    expect(resolveLatestCost([s(0.07)])).toMatchObject({ unitCostCents: 7 });
  });
  it("never substitutes fixed cost or invents zero: no latest cost is MISSING, with a reason", () => {
    expect(resolveLatestCost([])).toMatchObject({ status: "MISSING" });
    expect(resolveLatestCost([s(null, null, "A", 99)])).toMatchObject({ status: "MISSING" }); // fixed cost present, latest absent -> still missing
    expect(resolveLatestCost([s(0, "2026-09-01")])).toMatchObject({ status: "MISSING" });
  });
  it("ambiguity is MISSING, not a guess; identical costs are not ambiguous", () => {
    expect(resolveLatestCost([s(10, "2026-09-01", "A"), s(11, "2026-09-01", "B")])).toMatchObject({ status: "MISSING" });
    expect(resolveLatestCost([s(10, null, "A"), s(11, null, "B")])).toMatchObject({ status: "MISSING" });
    expect(resolveLatestCost([s(10, null, "A"), s(10, null, "B")])).toMatchObject({ status: "LATEST", unitCostCents: 1000 });
    expect(resolveLatestCost([s(10, "2026-09-01", "A"), s(10, "2026-09-01", "B")])).toMatchObject({ status: "LATEST" });
  });
});

const at = "2026-10-29T08:00:00Z";
const latest = (c: number): CostEntry => ({ unitCostCents: c, source: "CIN7_LATEST", retrievedAt: at, supplier: "S" });
describe("the cost estimate over the frozen physical scope", () => {
  const scope = [{ sku: "A", description: "A", quantity: 2 }, { sku: "B", description: "B", quantity: 10 }, { sku: "A", description: "A (from a second package)", quantity: 3 }];
  it("counts a SKU that appears in several packages once, adding the quantities (no double counting)", () => {
    const e = buildCostEstimate(scope, { A: latest(1000), B: latest(250) });
    expect(e.lines.map((l) => [l.sku, l.quantity, l.totalCostCents])).toEqual([["A", 5, 5000], ["B", 10, 2500]]);
    expect(e.totalCostCents).toBe(7500);
    expect(e.incomplete).toBe(false);
  });
  it("a SKU without a cost is MISSING and flags the estimate incomplete; its cost is not silently zero in a 'complete' margin", () => {
    const e = buildCostEstimate(scope, { A: latest(1000) });
    expect(e.missingSkus).toEqual(["B"]);
    expect(e.incomplete).toBe(true);
    expect(physicalMargin(100_000, e)).toEqual({ complete: false, missing: 1, unresolved: 0, knownCostCents: 5000 });
  });
  it("a manual estimate stands in only as MANUAL (with its reason), and an unusable entry stays MISSING", () => {
    const e = buildCostEstimate(scope, { A: latest(1000), B: { unitCostCents: 300, source: "MANUAL_ESTIMATE", retrievedAt: at, reason: "Supplier quote 14 Oct", by: "est@x", at } });
    expect(e.lines.find((l) => l.sku === "B")).toMatchObject({ status: "MANUAL", reason: "Supplier quote 14 Oct", totalCostCents: 3000 });
    expect(buildCostEstimate(scope, { A: latest(0), B: latest(-5) }).missingSkus).toEqual(["A", "B"]);
    expect(buildCostEstimate(scope, { A: { unitCostCents: null, source: "CIN7_LATEST", retrievedAt: at }, B: latest(1) }).missingSkus).toEqual(["A"]);
  });
  it("a package with no SKU mapping makes the estimate incomplete even when every mapped SKU has a cost", () => {
    const e = buildCostEstimate([{ sku: "A", description: "A", quantity: 1 }], { A: latest(100) }, ["PP penning"]);
    expect(e.incomplete).toBe(true);
    expect(physicalMargin(1000, e)).toMatchObject({ complete: false, unresolved: 1 });
  });
  it("margin is computed only on a complete estimate", () => {
    const m = physicalMargin(10_000, buildCostEstimate([{ sku: "A", description: "A", quantity: 1 }], { A: latest(7000) }));
    expect(m).toMatchObject({ complete: true, gpCents: 3000, marginPct: 30 });
  });
  it("a changed current cost never touches an already-built (frozen) estimate", () => {
    const frozen = buildCostEstimate(scope, { A: latest(1000), B: latest(250) });
    const snapshot = JSON.stringify(frozen);
    buildCostEstimate(scope, { A: latest(9999), B: latest(9999) }); // a later estimate with new costs
    expect(JSON.stringify(frozen)).toBe(snapshot);
  });
});

describe("manual estimates are validated", () => {
  it("needs a positive whole-cent cost and a reason", () => {
    expect(validateManualEstimate(0, "supplier quote")).toMatch(/greater than zero/);
    expect(validateManualEstimate(10.5 as number, "supplier quote")).toMatch(/greater than zero/);
    expect(validateManualEstimate(100, "ok")).toMatch(/reason/);
    expect(validateManualEstimate(100, "Supplier quote 14 Oct")).toBeNull();
  });
});
