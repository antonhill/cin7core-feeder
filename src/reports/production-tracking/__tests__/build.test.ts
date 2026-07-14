import { describe, expect, it } from "vitest";
import { deriveCurrentOperation, computeWipCost, totalWastage, daysLate, isLate } from "@/reports/production-tracking/build";
import type { ProductionRun, ProductionRunOperation } from "@/cin7/production-order-run";

function operation(overrides: Partial<ProductionRunOperation> = {}): ProductionRunOperation {
  return {
    operationId: "op-1",
    order: 1,
    name: "Mixing",
    workCenterName: "Mixing",
    status: "PLANNED",
    plannedTime: null,
    actualTime: null,
    startDate: null,
    endDate: null,
    components: [],
    resourceCosts: [],
    inputProducts: [],
    outputProducts: [],
    finishedProducts: [],
    ...overrides,
  };
}

describe("deriveCurrentOperation", () => {
  it("picks the first non-COMPLETED operation by order ascending — matches MO-00019 live: Mixing COMPLETED, Blending PLANNED", () => {
    const operations = [
      operation({ order: 1, name: "Mixing", status: "COMPLETED" }),
      operation({ order: 2, name: "Blending", status: "PLANNED" }),
    ];
    expect(deriveCurrentOperation(operations)?.name).toBe("Blending");
  });

  it("returns null once every operation is COMPLETED", () => {
    const operations = [operation({ order: 1, status: "COMPLETED" }), operation({ order: 2, status: "COMPLETED" })];
    expect(deriveCurrentOperation(operations)).toBeNull();
  });

  it("returns null with no operations at all", () => {
    expect(deriveCurrentOperation([])).toBeNull();
  });

  it("doesn't assume input order matches sequence — sorts by `order` itself", () => {
    const operations = [
      operation({ order: 2, name: "Blending", status: "IN PROGRESS" }),
      operation({ order: 1, name: "Mixing", status: "COMPLETED" }),
    ];
    expect(deriveCurrentOperation(operations)?.name).toBe("Blending");
  });
});

function run(overrides: Partial<ProductionRun> = {}): ProductionRun {
  return { runId: "run-1", number: 1, status: "IN PROGRESS", wipAccount: "780", operations: [], ...overrides };
}

describe("computeWipCost", () => {
  it("sums ResourceCosts across operations of a non-completed run", () => {
    const runs = [
      run({
        status: "IN PROGRESS",
        operations: [
          operation({ resourceCosts: [{ expenseAccount: "310", cost: 0.456 }] }),
          operation({ resourceCosts: [{ expenseAccount: "310", cost: 1.5 }] }),
        ],
      }),
    ];
    expect(computeWipCost(runs)).toBeCloseTo(1.956);
  });

  it("excludes COMPLETED runs", () => {
    const runs = [run({ status: "COMPLETED", operations: [operation({ resourceCosts: [{ expenseAccount: "310", cost: 100 }] })] })];
    expect(computeWipCost(runs)).toBe(0);
  });

  it("excludes VOIDED runs", () => {
    const runs = [run({ status: "VOIDED", operations: [operation({ resourceCosts: [{ expenseAccount: "310", cost: 100 }] })] })];
    expect(computeWipCost(runs)).toBe(0);
  });

  it("returns 0 for no runs / no resource costs", () => {
    expect(computeWipCost([])).toBe(0);
    expect(computeWipCost([run({ operations: [operation()] })])).toBe(0);
  });
});

describe("totalWastage", () => {
  it("sums WastageQty across every operation's components", () => {
    const operations = [
      operation({ components: [{ productCode: "A", quantity: 1, expectedQuantity: 1, wastageQty: 0.2, unitCost: 0 }] }),
      operation({ components: [{ productCode: "B", quantity: 1, expectedQuantity: 1, wastageQty: 0.3, unitCost: 0 }] }),
    ];
    expect(totalWastage(operations)).toBeCloseTo(0.5);
  });

  it("returns 0 when every component has zero wastage (the real-world case seen so far)", () => {
    const operations = [operation({ components: [{ productCode: "A", quantity: 1, expectedQuantity: 1, wastageQty: 0, unitCost: 0 }] })];
    expect(totalWastage(operations)).toBe(0);
  });
});

describe("daysLate / isLate", () => {
  it("daysLate returns null with no required-by date", () => {
    expect(daysLate(null, "2026-07-14")).toBeNull();
  });

  it("daysLate is positive once the required-by date has passed", () => {
    expect(daysLate("2026-07-10", "2026-07-14")).toBe(4);
  });

  it("daysLate is 0 or negative before/on the required-by date", () => {
    expect(daysLate("2026-07-14", "2026-07-14")).toBe(0);
    expect(daysLate("2026-07-20", "2026-07-14")).toBe(-6);
  });

  it("isLate is true once required-by has passed and the order is still open", () => {
    expect(isLate("2026-07-10", "IN PROGRESS", "2026-07-14")).toBe(true);
  });

  it("isLate is false before the required-by date", () => {
    expect(isLate("2026-07-20", "IN PROGRESS", "2026-07-14")).toBe(false);
  });

  it("isLate is false for a COMPLETED order even if it finished after its due date", () => {
    expect(isLate("2026-07-10", "COMPLETED", "2026-07-14")).toBe(false);
  });

  it("isLate is false for a VOIDED order", () => {
    expect(isLate("2026-07-10", "VOIDED", "2026-07-14")).toBe(false);
  });

  it("isLate is false with no required-by date at all", () => {
    expect(isLate(null, "IN PROGRESS", "2026-07-14")).toBe(false);
  });
});
