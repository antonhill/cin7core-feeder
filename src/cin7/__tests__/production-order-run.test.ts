import { describe, expect, it } from "vitest";
import { pickLatestRun, actualWastageBySku } from "@/cin7/production-order-run";
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
    ...overrides,
  };
}

function run(overrides: Partial<ProductionRun> = {}): ProductionRun {
  return { runId: "run-1", number: 1, status: "IN PROGRESS", wipAccount: "780", operations: [], ...overrides };
}

describe("pickLatestRun", () => {
  it("picks the run with the highest number", () => {
    const runs = [run({ runId: "a", number: 1 }), run({ runId: "b", number: 3 }), run({ runId: "c", number: 2 })];
    expect(pickLatestRun(runs)?.runId).toBe("b");
  });

  it("returns null with no runs", () => {
    expect(pickLatestRun([])).toBeNull();
  });

  it("returns the only run when there's just one", () => {
    expect(pickLatestRun([run({ runId: "only" })])?.runId).toBe("only");
  });
});

describe("actualWastageBySku", () => {
  it("sums WastageQty for one SKU across multiple operations", () => {
    const r = run({
      operations: [
        operation({ components: [{ productCode: "RAW0001", quantity: 1, expectedQuantity: 1, wastageQty: 0.2 }] }),
        operation({ components: [{ productCode: "RAW0001", quantity: 1, expectedQuantity: 1, wastageQty: 0.3 }] }),
      ],
    });
    expect(actualWastageBySku(r).get("RAW0001")).toBeCloseTo(0.5);
  });

  it("keeps different SKUs separate", () => {
    const r = run({
      operations: [
        operation({
          components: [
            { productCode: "RAW0001", quantity: 1, expectedQuantity: 1, wastageQty: 0.2 },
            { productCode: "RAW0002", quantity: 1, expectedQuantity: 1, wastageQty: 0.1 },
          ],
        }),
      ],
    });
    expect(actualWastageBySku(r).get("RAW0001")).toBeCloseTo(0.2);
    expect(actualWastageBySku(r).get("RAW0002")).toBeCloseTo(0.1);
  });

  it("skips components with no productCode", () => {
    const r = run({ operations: [operation({ components: [{ productCode: null, quantity: 1, expectedQuantity: 1, wastageQty: 5 }] })] });
    expect(actualWastageBySku(r).size).toBe(0);
  });

  it("returns an empty map for a null run (order never released)", () => {
    expect(actualWastageBySku(null).size).toBe(0);
  });
});
