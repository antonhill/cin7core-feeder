import { describe, expect, it } from "vitest";
import { buildCostingReport, type CostingInput } from "../costing-report";
import { invoiceLineCostsBySku } from "../physical-adapter";

const R = (n: number) => n * 100;
const input = (over: Partial<CostingInput> = {}): CostingInput => ({
  base: {
    contractCents: R(100_000), estimatedCostCents: R(60_000), uncostedSellingCents: R(10_000),
    stages: [{ name: "Deposit", valueCents: R(40_000) }, { name: "Delivery", valueCents: R(55_000) }, { name: "Installation", valueCents: R(5_000) }],
    lines: [
      { itemKey: "bcg", label: "Battery charger", section: "Other equipment", sku: "NQCP137", sellingCents: R(40_000), costCents: R(20_000) },
      { itemKey: "pen", label: "Penning", section: "Penning", sku: null, sellingCents: R(50_000), costCents: R(40_000), components: [
        { sku: "ROLL", description: "Roll", sellingCents: R(30_000), costCents: R(25_000) }, { sku: "POST", description: "Post", sellingCents: R(20_000), costCents: R(15_000) }] },
    ],
  },
  variations: [{ code: "V001", contractCents: R(5_000), estimatedCostCents: R(3_000) }],
  actualBySku: { NQCP137: { quantity: 1, costCents: R(50) }, ROLL: { quantity: 2, costCents: R(26_000) } },
  supplierBySku: { NQCP137: "Acme Power", ROLL: "Acme Power", POST: null },
  nonStock: { incurredCents: R(2_000), committedCents: R(3_000), byCategory: {} },
  revisedContractCents: R(105_000), ...over,
});

describe("costing report dimensions", () => {
  it("by SKU: estimated from the sold components, actual from invoice lines; variance only when both are known; an uninvoiced SKU has incurred nothing yet", () => {
    const r = buildCostingReport(input());
    const by = Object.fromEntries(r.bySku.map((s) => [s.sku, s]));
    expect(by["NQCP137"]).toMatchObject({ estimatedCents: R(20_000), actualCents: R(50), varianceCents: R(50) - R(20_000) });
    expect(by["ROLL"]).toMatchObject({ estimatedCents: R(25_000), actualCents: R(26_000), varianceCents: R(1_000) });
    expect(by["POST"]).toMatchObject({ estimatedCents: R(15_000), actualCents: 0, actualQuantity: 0 });
  });
  it("UNREADABLE invoice lines make actuals and variances unknown - never zero", () => {
    const r = buildCostingReport(input({ actualBySku: null }));
    expect(r.bySku.every((s) => s.actualCents === null && s.varianceCents === null)).toBe(true);
    expect(r.budget.incurredStockCostCents).toBeNull();
    expect(r.budget.stockVarianceCents).toBeNull();
  });
  it("by section / package keeps margin; by stage allocates cost pro rata to stage value and says so", () => {
    const r = buildCostingReport(input());
    expect(r.bySection.map((s) => [s.section, s.sellingCents, s.costCents])).toEqual([["Other equipment", R(40_000), R(20_000)], ["Penning", R(50_000), R(40_000)]]);
    expect(r.byStage.map((s) => [s.stage, s.estimatedCostCents])).toEqual([["Deposit", R(24_000)], ["Delivery", R(33_000)], ["Installation", R(3_000)]]);
    expect(r.byStage.reduce((n, s) => n + (s.estimatedCostCents ?? 0), 0)).toBe(R(60_000));
    expect(r.basisNotes.join()).toMatch(/pro rata/);
  });
  it("by supplier groups SKUs by the recorded last supplier; missing supplier is its own group, unknown costs stay unknown", () => {
    const r = buildCostingReport(input());
    expect(r.bySupplier).toEqual([
      { supplier: "Acme Power", skus: 2, estimatedCents: R(45_000), actualCents: R(50) + R(26_000) },
      { supplier: "Supplier not recorded", skus: 1, estimatedCents: R(15_000), actualCents: 0 },
    ]);
  });
  it("by scope: BASE vs variation", () => {
    const r = buildCostingReport(input());
    expect(r.byScope.map((s) => [s.scope, s.estimatedCostCents, s.estimated.gpCents])).toEqual([["Original contract", R(60_000), R(30_000)], ["V001 variation", R(3_000), R(2_000)]]);
  });
  it("budget vs actual and expected final margin: stock = larger of estimate and incurred; non-stock = incurred + committed", () => {
    const r = buildCostingReport(input());
    expect(r.budget).toMatchObject({ estimatedStockCostCents: R(63_000), incurredStockCostCents: R(50) + R(26_000), nonStockIncurredCents: R(2_000), nonStockCommittedCents: R(3_000) });
    expect(r.budget.expectedFinalCostCents).toBe(R(63_000) + R(5_000));
    expect(r.budget.marginBasis).toBe("FULL_CONTRACT"); // non-stock costs exist, so services are costed
    expect(r.budget.expectedFinalMargin).toMatchObject({ sellingCents: R(105_000), costCents: R(68_000), gpCents: R(37_000) });
    // over budget on stock: the forecast follows the larger incurred figure
    const over = buildCostingReport(input({ actualBySku: { ROLL: { quantity: 9, costCents: R(70_000) } } }));
    expect(over.budget.expectedFinalCostCents).toBe(R(70_000) + R(5_000));
  });
  it("without recorded non-stock costs the services are left out of the margin and the basis says so; unknown estimate or ledger => unknown margin", () => {
    const r = buildCostingReport(input({ nonStock: { incurredCents: 0, committedCents: 0, byCategory: {} } }));
    expect(r.budget.marginBasis).toBe("COSTED_SCOPE_ONLY");
    expect(r.budget.expectedFinalMargin?.sellingCents).toBe(R(95_000));
    expect(buildCostingReport(input({ nonStock: null })).budget.expectedFinalMargin).toBeNull();
    expect(buildCostingReport(input({ base: null, variations: [{ code: "V001", contractCents: R(5_000), estimatedCostCents: null }] })).budget.expectedFinalMargin).toBeNull();
  });
});

describe("invoice-line cost by SKU (NQCP137 R50 on a DRAFT invoice; header COGS is a different, later figure)", () => {
  it("groups by SKU, ignores VOIDED invoices, and is null when any line is unreadable", () => {
    expect(invoiceLineCostsBySku([
      { Status: "DRAFT", Lines: [{ SKU: "NQCP137", Quantity: 1, AverageCost: 50 }] },
      { Status: "AUTHORISED", Lines: [{ SKU: "NQCP137", Quantity: 2, AverageCost: 50 }, { SKU: "KNQPP014", Quantity: 1, AverageCost: 107.4209 }] },
      { Status: "VOIDED", Lines: [{ SKU: "X", Quantity: 5, AverageCost: 9 }] },
    ])).toEqual({ NQCP137: { quantity: 3, costCents: 15_000 }, KNQPP014: { quantity: 1, costCents: 10_742 } });
    expect(invoiceLineCostsBySku([{ Status: "DRAFT", Lines: [{ SKU: "A", Quantity: 1, AverageCost: 0 }] }])).toBeNull();
    expect(invoiceLineCostsBySku([{ Status: "DRAFT", Lines: [{ Quantity: 1, AverageCost: 5 }] }])).toBeNull();
    expect(invoiceLineCostsBySku([{ Status: "DRAFT" }])).toBeNull();
    expect(invoiceLineCostsBySku([])).toEqual({});
  });
});
