import { describe, expect, it } from "vitest";
import {
  deriveCurrentOperation,
  computeWipCost,
  totalWastage,
  daysLate,
  isLate,
  groupByWorkCentre,
  groupByStatus,
  cumulativeCostThroughStage,
  hasInputShortfall,
  hasInputOverproduction,
  operationHasInputShortfall,
  operationHasInputOverproduction,
  previousOperation,
  reconcileInputFlow,
  NOT_STARTED_COLUMN,
  AWAITING_OUTPUT_COLUMN,
} from "@/reports/production-tracking/build";
import type { ProductionRun, ProductionRunOperation } from "@/cin7/production-order-run";
import type { ProductionTrackingRow, ProductionOperationRow } from "@/reports/production-tracking/query";

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
  return { runId: "run-1", number: 1, status: "IN PROGRESS", wipAccount: "780", quantity: 1, operations: [], ...overrides };
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

function trackingRow(overrides: Partial<ProductionTrackingRow> = {}): ProductionTrackingRow {
  return {
    productionOrderId: "po-1",
    orderNumber: "MO-1",
    productSku: "SKU-1",
    productName: "Product 1",
    locationName: "Main",
    listStatus: "IN PROGRESS",
    requiredByDate: null,
    completionDate: null,
    runStatus: "IN PROGRESS",
    wipAccount: "780",
    currentOperationName: "Mixing",
    currentWorkCenterName: "Mixing",
    currentOperationOrder: 1,
    currentOperationStartedAt: null,
    plannedQuantity: null,
    currentInputExpectedQty: null,
    currentInputActualQty: null,
    currentInputWastageQty: null,
    wipActualCost: 0,
    runSyncedAt: null,
    totalWastage: 0,
    ...overrides,
  };
}

describe("groupByWorkCentre", () => {
  it("buckets orders by currentWorkCenterName", () => {
    const rows = [
      trackingRow({ productionOrderId: "a", currentWorkCenterName: "Mixing", currentOperationOrder: 1 }),
      trackingRow({ productionOrderId: "b", currentWorkCenterName: "Blending", currentOperationOrder: 2 }),
      trackingRow({ productionOrderId: "c", currentWorkCenterName: "Mixing", currentOperationOrder: 1 }),
    ];
    const columns = groupByWorkCentre(rows);
    const mixing = columns.find((c) => c.workCentre === "Mixing");
    expect(mixing?.orders.map((o) => o.productionOrderId).sort()).toEqual(["a", "c"]);
  });

  it("puts orders with no current work centre in the NOT_STARTED_COLUMN bucket", () => {
    const rows = [trackingRow({ currentWorkCenterName: null, currentOperationOrder: null })];
    const columns = groupByWorkCentre(rows);
    expect(columns).toHaveLength(1);
    expect(columns[0].workCentre).toBe(NOT_STARTED_COLUMN);
  });

  it("sorts NOT_STARTED_COLUMN first regardless of other columns' operation order", () => {
    const rows = [
      trackingRow({ productionOrderId: "a", currentWorkCenterName: "Blending", currentOperationOrder: 1 }),
      trackingRow({ productionOrderId: "b", currentWorkCenterName: null, currentOperationOrder: null }),
    ];
    const columns = groupByWorkCentre(rows);
    expect(columns[0].workCentre).toBe(NOT_STARTED_COLUMN);
  });

  it("orders remaining columns by the lowest currentOperationOrder seen in each", () => {
    const rows = [
      trackingRow({ productionOrderId: "a", currentWorkCenterName: "Blending", currentOperationOrder: 3 }),
      trackingRow({ productionOrderId: "b", currentWorkCenterName: "Mixing", currentOperationOrder: 1 }),
      trackingRow({ productionOrderId: "c", currentWorkCenterName: "Packing", currentOperationOrder: 2 }),
    ];
    const columns = groupByWorkCentre(rows);
    expect(columns.map((c) => c.workCentre)).toEqual(["Mixing", "Packing", "Blending"]);
  });

  it("returns no columns for an empty row set", () => {
    expect(groupByWorkCentre([])).toEqual([]);
  });

  // Confirmed live 2026-07-14 (MO-00042): after Packing's last operation completes, run_status reads
  // "OPERATIONS COMPLETED" and currentWorkCenterName goes null — same null as a NOT-yet-started order,
  // but it means the opposite thing (finished, not unstarted), so it needs its own bucket.
  it("puts a finished-operations order awaiting output in AWAITING_OUTPUT_COLUMN, not NOT_STARTED_COLUMN", () => {
    const rows = [trackingRow({ currentWorkCenterName: null, currentOperationOrder: null, runStatus: "OPERATIONS COMPLETED" })];
    const columns = groupByWorkCentre(rows);
    expect(columns).toHaveLength(1);
    expect(columns[0].workCentre).toBe(AWAITING_OUTPUT_COLUMN);
  });

  it("sorts AWAITING_OUTPUT_COLUMN last, after NOT_STARTED_COLUMN and every real work-centre column", () => {
    const rows = [
      trackingRow({ productionOrderId: "a", currentWorkCenterName: null, currentOperationOrder: null, runStatus: "OPERATIONS COMPLETED" }),
      trackingRow({ productionOrderId: "b", currentWorkCenterName: "Mixing", currentOperationOrder: 1 }),
      trackingRow({ productionOrderId: "c", currentWorkCenterName: null, currentOperationOrder: null, runStatus: null }),
    ];
    const columns = groupByWorkCentre(rows);
    expect(columns.map((c) => c.workCentre)).toEqual([NOT_STARTED_COLUMN, "Mixing", AWAITING_OUTPUT_COLUMN]);
  });
});

describe("groupByStatus", () => {
  it("orders columns by the fixed lifecycle sequence, not input order", () => {
    const rows = [
      trackingRow({ productionOrderId: "a", listStatus: "RELEASED" }),
      trackingRow({ productionOrderId: "b", listStatus: "DRAFT" }),
      trackingRow({ productionOrderId: "c", listStatus: "PLANNED" }),
    ];
    const columns = groupByStatus(rows);
    expect(columns.map((c) => c.workCentre)).toEqual(["DRAFT", "PLANNED", "RELEASED", "IN PROGRESS", "COMPLETED", "VOIDED"]);
  });

  it("includes every known status as its own column even with zero orders in it", () => {
    const columns = groupByStatus([trackingRow({ listStatus: "DRAFT" })]);
    const draft = columns.find((c) => c.workCentre === "DRAFT");
    const planned = columns.find((c) => c.workCentre === "PLANNED");
    expect(draft?.orders).toHaveLength(1);
    expect(planned?.orders).toHaveLength(0);
  });

  it("hides a column entirely when its status is in the hidden set", () => {
    const rows = [trackingRow({ listStatus: "DRAFT" }), trackingRow({ listStatus: "PLANNED" })];
    const columns = groupByStatus(rows, new Set(["DRAFT"]));
    expect(columns.map((c) => c.workCentre)).not.toContain("DRAFT");
    expect(columns.map((c) => c.workCentre)).toContain("PLANNED");
  });

  it("drops rows whose status is hidden rather than bucketing them elsewhere", () => {
    const rows = [trackingRow({ productionOrderId: "a", listStatus: "DRAFT" })];
    const columns = groupByStatus(rows, new Set(["DRAFT"]));
    const allOrders = columns.flatMap((c) => c.orders);
    expect(allOrders).toHaveLength(0);
  });
});

function operationRow(overrides: Partial<ProductionOperationRow> = {}): ProductionOperationRow {
  return {
    operationOrder: 1,
    operationName: "Mixing",
    workCenterName: "Mixing",
    status: "COMPLETED",
    plannedTime: null,
    actualTime: null,
    startDate: null,
    endDate: null,
    actualResourceCost: 0,
    actualMaterialCost: 0,
    wastageQty: 0,
    inputExpectedQty: null,
    inputActualQty: null,
    inputWastageQty: null,
    outputQty: null,
    outputWastageQty: null,
    ...overrides,
  };
}

describe("cumulativeCostThroughStage", () => {
  it("sums resource + material cost up to and including the given stage", () => {
    const operations = [
      operationRow({ operationOrder: 1, actualResourceCost: 10, actualMaterialCost: 5 }),
      operationRow({ operationOrder: 2, actualResourceCost: 20, actualMaterialCost: 15 }),
    ];
    expect(cumulativeCostThroughStage(operations, 2)).toBe(50);
  });

  it("excludes stages after uptoOrder", () => {
    const operations = [
      operationRow({ operationOrder: 1, actualResourceCost: 10, actualMaterialCost: 5 }),
      operationRow({ operationOrder: 2, actualResourceCost: 20, actualMaterialCost: 15 }),
    ];
    expect(cumulativeCostThroughStage(operations, 1)).toBe(15);
  });

  it("treats null cost fields as 0", () => {
    const operations = [operationRow({ operationOrder: 1, actualResourceCost: null, actualMaterialCost: null })];
    expect(cumulativeCostThroughStage(operations, 1)).toBe(0);
  });

  it("doesn't assume operations are pre-sorted", () => {
    const operations = [
      operationRow({ operationOrder: 2, actualResourceCost: 20, actualMaterialCost: 0 }),
      operationRow({ operationOrder: 1, actualResourceCost: 10, actualMaterialCost: 0 }),
    ];
    expect(cumulativeCostThroughStage(operations, 1)).toBe(10);
  });
});

describe("hasInputShortfall", () => {
  it("is true when a started stage received less than expected, even if Cin7's own WastageQuantity is 0", () => {
    // Confirmed live 2026-07-14 (MO-00042): Grinding expected 25.5kg from Roasting, received only
    // 23.5kg, but Cin7's InputProducts.WastageQuantity showed 0 — comparing actual vs expected directly
    // is what catches this, not trusting WastageQuantity alone.
    expect(
      hasInputShortfall(trackingRow({ currentOperationStartedAt: "2026-07-14T00:00:00", currentInputExpectedQty: 25.5, currentInputActualQty: 23.5 }))
    ).toBe(true);
  });

  it("is false when the current stage's BOM doesn't track Inputs/Outputs at all", () => {
    expect(
      hasInputShortfall(
        trackingRow({ currentOperationStartedAt: "2026-07-14T00:00:00", currentInputExpectedQty: null, currentInputActualQty: null })
      )
    ).toBe(false);
  });

  it("is false when tracked but the full expected amount was received", () => {
    expect(
      hasInputShortfall(trackingRow({ currentOperationStartedAt: "2026-07-14T00:00:00", currentInputExpectedQty: 25.5, currentInputActualQty: 25.5 }))
    ).toBe(false);
  });

  it("is false for a not-yet-started stage (0 received is expected, not a shortfall)", () => {
    expect(
      hasInputShortfall(trackingRow({ currentOperationStartedAt: null, currentInputExpectedQty: 25.5, currentInputActualQty: 0 }))
    ).toBe(false);
  });
});

describe("operationHasInputShortfall", () => {
  it("is true for a started operation that received less than expected, even with WastageQuantity 0", () => {
    expect(operationHasInputShortfall(operationRow({ startDate: "2026-07-14T00:00:00", inputExpectedQty: 25.5, inputActualQty: 23.5 }))).toBe(true);
  });

  it("is false for an operation that hasn't started (startDate null)", () => {
    expect(operationHasInputShortfall(operationRow({ startDate: null, inputExpectedQty: 25.5, inputActualQty: 0 }))).toBe(false);
  });

  it("is false when the operation doesn't track Inputs/Outputs at all", () => {
    expect(operationHasInputShortfall(operationRow({ startDate: "2026-07-14T00:00:00", inputExpectedQty: null, inputActualQty: null }))).toBe(false);
  });

  it("is false when the full expected amount was received", () => {
    expect(operationHasInputShortfall(operationRow({ startDate: "2026-07-14T00:00:00", inputExpectedQty: 25.5, inputActualQty: 25.5 }))).toBe(false);
  });
});

describe("hasInputOverproduction", () => {
  it("is true when the current stage received more than expected", () => {
    expect(
      hasInputOverproduction(trackingRow({ currentOperationStartedAt: "2026-07-14T00:00:00", currentInputExpectedQty: 25, currentInputActualQty: 27 }))
    ).toBe(true);
  });

  it("is false when the full expected amount was received (on target)", () => {
    expect(
      hasInputOverproduction(trackingRow({ currentOperationStartedAt: "2026-07-14T00:00:00", currentInputExpectedQty: 25, currentInputActualQty: 25 }))
    ).toBe(false);
  });

  it("is false when it's actually a shortfall, not overproduction", () => {
    expect(
      hasInputOverproduction(trackingRow({ currentOperationStartedAt: "2026-07-14T00:00:00", currentInputExpectedQty: 25, currentInputActualQty: 23 }))
    ).toBe(false);
  });

  it("is false when the current stage's BOM doesn't track Inputs/Outputs at all", () => {
    expect(
      hasInputOverproduction(
        trackingRow({ currentOperationStartedAt: "2026-07-14T00:00:00", currentInputExpectedQty: null, currentInputActualQty: null })
      )
    ).toBe(false);
  });
});

describe("operationHasInputOverproduction", () => {
  it("is true for a started operation that received more than expected", () => {
    expect(operationHasInputOverproduction(operationRow({ startDate: "2026-07-14T00:00:00", inputExpectedQty: 25, inputActualQty: 27 }))).toBe(true);
  });

  it("is false for an operation that hasn't started", () => {
    expect(operationHasInputOverproduction(operationRow({ startDate: null, inputExpectedQty: 25, inputActualQty: 27 }))).toBe(false);
  });

  it("is false when it's a shortfall rather than overproduction", () => {
    expect(operationHasInputOverproduction(operationRow({ startDate: "2026-07-14T00:00:00", inputExpectedQty: 25, inputActualQty: 23 }))).toBe(false);
  });
});

describe("previousOperation", () => {
  it("returns the operation with the highest operationOrder below the given one", () => {
    const operations = [
      operationRow({ operationOrder: 10, operationName: "Roasting" }),
      operationRow({ operationOrder: 20, operationName: "Grinding" }),
      operationRow({ operationOrder: 30, operationName: "Packing" }),
    ];
    expect(previousOperation(operations, 20)?.operationName).toBe("Roasting");
    expect(previousOperation(operations, 30)?.operationName).toBe("Grinding");
  });

  it("returns null for the first operation", () => {
    const operations = [operationRow({ operationOrder: 10, operationName: "Roasting" })];
    expect(previousOperation(operations, 10)).toBeNull();
  });

  it("doesn't assume operations are pre-sorted", () => {
    const operations = [
      operationRow({ operationOrder: 30, operationName: "Packing" }),
      operationRow({ operationOrder: 10, operationName: "Roasting" }),
      operationRow({ operationOrder: 20, operationName: "Grinding" }),
    ];
    expect(previousOperation(operations, 30)?.operationName).toBe("Grinding");
  });
});

describe("reconcileInputFlow", () => {
  it("returns null when no operation tracks Inputs/Outputs at all", () => {
    const operations = [
      operationRow({ operationOrder: 10, operationName: "Roasting", inputExpectedQty: null, inputActualQty: null }),
      operationRow({ operationOrder: 20, operationName: "Grinding", inputExpectedQty: null, inputActualQty: null }),
    ];
    expect(reconcileInputFlow(operations)).toBeNull();
  });

  it("returns null when every tracked stage received exactly what was expected", () => {
    const operations = [
      operationRow({ operationOrder: 20, operationName: "Grinding", inputExpectedQty: 25.5, inputActualQty: 25.5 }),
      operationRow({ operationOrder: 30, operationName: "Packing", inputExpectedQty: 25, inputActualQty: 25 }),
    ];
    expect(reconcileInputFlow(operations)).toBeNull();
  });

  // Confirmed live 2026-07-14 (MO-00042): Grinding received 23.5 of 25.5 expected (the origin), and by
  // the time it reaches Packing the net deviation is still exactly -2 — the same loss carried forward
  // unchanged, not a second separate loss.
  it("reports the origin and net figure as unchanged when the deviation doesn't grow between stages", () => {
    const operations = [
      operationRow({ operationOrder: 20, operationName: "Grinding", inputExpectedQty: 25.5, inputActualQty: 23.5 }),
      operationRow({ operationOrder: 30, operationName: "Packing", inputExpectedQty: 25, inputActualQty: 23 }),
    ];
    expect(reconcileInputFlow(operations)).toEqual({
      originOperationName: "Grinding",
      originDeviationQty: -2,
      finalOperationName: "Packing",
      netDeviationQty: -2,
    });
  });

  it("reports a widening deviation with both figures when it grows further downstream", () => {
    const operations = [
      operationRow({ operationOrder: 20, operationName: "Grinding", inputExpectedQty: 25.5, inputActualQty: 23.5 }),
      operationRow({ operationOrder: 30, operationName: "Packing", inputExpectedQty: 25, inputActualQty: 20 }),
    ];
    expect(reconcileInputFlow(operations)).toEqual({
      originOperationName: "Grinding",
      originDeviationQty: -2,
      finalOperationName: "Packing",
      netDeviationQty: -5,
    });
  });

  it("uses the same operation for origin and final when only one tracked stage has a deviation so far", () => {
    const operations = [operationRow({ operationOrder: 20, operationName: "Grinding", inputExpectedQty: 25.5, inputActualQty: 23.5 })];
    expect(reconcileInputFlow(operations)).toEqual({
      originOperationName: "Grinding",
      originDeviationQty: -2,
      finalOperationName: "Grinding",
      netDeviationQty: -2,
    });
  });

  it("handles overproduction (positive deviation) the same way", () => {
    const operations = [
      operationRow({ operationOrder: 20, operationName: "Grinding", inputExpectedQty: 25, inputActualQty: 27 }),
      operationRow({ operationOrder: 30, operationName: "Packing", inputExpectedQty: 25, inputActualQty: 27 }),
    ];
    expect(reconcileInputFlow(operations)).toEqual({
      originOperationName: "Grinding",
      originDeviationQty: 2,
      finalOperationName: "Packing",
      netDeviationQty: 2,
    });
  });
});
