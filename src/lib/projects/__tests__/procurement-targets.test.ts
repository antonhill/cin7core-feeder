import { describe, expect, it } from "vitest";
import { buildCostEstimate, type CostEntry } from "../latest-cost";
import { buildProcurementTargets } from "../procurement-targets";
import { normaliseOption } from "../supplier-price";

/** Today's Cin7 price for one supplier ("Acme", ZAR), in cents; null = Cin7 holds no price. */
const cur = (cents: number | null) => ({ options: [normaliseOption({ supplierId: "s1", supplierName: "Acme", cost: cents === null ? null : cents / 100, currency: "ZAR", lastSupplied: at }, { fx: {}, nowIso: at, maxRateAgeHours: 72, unitBasis: { basis: "STOCK_UNIT", confirmedBy: "x", confirmedAt: at, reason: "per stock unit confirmed" } })], readAt: at });

const at = "2026-10-29T08:00:00Z";
const latest = (c: number): CostEntry => ({ unitCostCents: c, source: "CIN7_LATEST", retrievedAt: at, supplier: "Acme" });
const scope = [{ sku: "A", description: "Silo", quantity: 15 }, { sku: "B", description: "Slat", quantity: 100 }, { sku: "A", description: "Silo (2nd package)", quantity: 5 }];
const estimate = buildCostEstimate(scope, { A: latest(10_000), B: { unitCostCents: 250, source: "MANUAL_ESTIMATE", retrievedAt: at, reason: "Quote 14 Oct" } });

describe("procurement cost targets", () => {
  it("shows the frozen allowed cost beside today's latest cost and the difference, per SKU and across the required quantity", () => {
    const { rows, totals } = buildProcurementTargets({ estimate, scope, physical: [{ sku: "A", ordered: 20, onHand: 12, available: 9, shortfall: 11, remainingToDeliver: 20 }, { sku: "B", ordered: 100, onHand: 500, available: 500, shortfall: 0, remainingToDeliver: 100 }],
      current: { A: cur(11_000), B: cur(200) }, actual: null });
    const a = rows.find((r) => r.sku === "A")!;
    expect(a).toMatchObject({ requiredQuantity: 20, approvedUnitCostCents: 10_000, approvedTotalCostCents: 200_000, currentUnitCostCents: 11_000, unitVarianceCents: 1000, totalVarianceCents: 20_000, shortfall: 11, approvedBasis: "CIN7_LATEST", supplier: "Acme" });
    const b = rows.find((r) => r.sku === "B")!;
    expect(b).toMatchObject({ approvedBasis: "MANUAL_ESTIMATE", approvedReason: "Quote 14 Oct", unitVarianceCents: -50, totalVarianceCents: -5000 });
    expect(rows).toHaveLength(2); // a SKU in two packages is one row, quantities added
    expect(totals).toMatchObject({ approvedTotalCents: 225_000, currentTotalCents: 240_000, varianceCents: 15_000, missingApproved: 0, missingCurrent: 0 });
  });
  it("changing today's cost never changes the approved budget", () => {
    const base = { estimate, scope, physical: [], actual: null };
    const first = buildProcurementTargets({ ...base, current: { A: cur(10_000), B: cur(250) } });
    const later = buildProcurementTargets({ ...base, current: { A: cur(99_999), B: cur(99_999) } });
    expect(later.rows.map((r) => [r.sku, r.approvedUnitCostCents, r.approvedTotalCostCents])).toEqual(first.rows.map((r) => [r.sku, r.approvedUnitCostCents, r.approvedTotalCostCents]));
    expect(later.totals.approvedTotalCents).toBe(first.totals.approvedTotalCents);
  });
  it("unknown stays unknown: no estimate captured, no usable current cost, no stock read - flagged, never zero, and no total is claimed", () => {
    const { rows, totals, estimateCaptured } = buildProcurementTargets({ estimate: null, scope, physical: [], current: { A: cur(null) }, actual: null });
    expect(estimateCaptured).toBe(false);
    const a = rows[0];
    expect(a).toMatchObject({ approvedBasis: "NOT_CAPTURED", approvedUnitCostCents: null, currentUnitCostCents: null, unitVarianceCents: null, shortfall: null, available: null });
    expect(a.flags.join(" ")).toMatch(/No cost estimate was captured/);
    expect(a.flags.join(" ")).toMatch(/no usable supplier price/);
    expect(a.flags.join(" ")).toMatch(/Stock was not read/);
    expect(totals).toMatchObject({ approvedTotalCents: null, currentTotalCents: null, varianceCents: null, missingApproved: 2 });
  });
  it("an actual cost is shown only as what Cin7 recognised, and is never filled from the estimate", () => {
    const { rows } = buildProcurementTargets({ estimate, scope, physical: [], current: null, actual: { A: { quantity: 10, costCents: 105_000 } } });
    expect(rows.find((r) => r.sku === "A")).toMatchObject({ actualUnitCostCents: 10_500, actualQuantity: 10 });
    expect(rows.find((r) => r.sku === "B")).toMatchObject({ actualUnitCostCents: null, actualQuantity: null });
  });
  it("shortfall falls back to required - available only when stock was read", () => {
    const r = buildProcurementTargets({ estimate, scope, physical: [{ sku: "A", ordered: null, onHand: 5, available: 5, shortfall: null, remainingToDeliver: null }], current: null, actual: null }).rows.find((x) => x.sku === "A")!;
    expect(r.shortfall).toBe(15);
  });
});
