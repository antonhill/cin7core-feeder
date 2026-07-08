import { describe, expect, it } from "vitest";
import { estimateProductionCost } from "@/costing/production-estimate";
import type { ComponentCostInfo } from "@/costing/estimate";
import type { CostEstimatorBomLine } from "@/cin7/product-cost";
import type { ProductionResourceLine } from "@/cin7/production-order-detail";

describe("estimateProductionCost", () => {
  const componentLines: CostEstimatorBomLine[] = [
    {
      componentSku: "A",
      componentName: "Widget A",
      quantity: 2,
      wastageQuantity: 1,
    },
    {
      componentSku: "B",
      componentName: "Widget B",
      quantity: 3,
      wastageQuantity: 0,
    },
  ];

  it("re-prices components under the chosen basis, same as an Assembly BOM", () => {
    const costs = new Map<string, ComponentCostInfo>([
      ["A", { averageCost: 10, suppliers: [] }],
      ["B", { averageCost: 5, suppliers: [] }],
    ]);
    const estimate = estimateProductionCost(
      "PROD-1",
      "Production One",
      "MO-00001",
      "2026-01-01T00:00:00",
      componentLines,
      [],
      costs,
      "average",
    );
    // A: (2 + 1) * 10 = 30, B: 3 * 5 = 15
    expect(estimate.componentLines[0].lineCost).toBe(30);
    expect(estimate.componentLines[1].lineCost).toBe(15);
    expect(estimate.componentTotalCost).toBe(45);
    expect(estimate.resourceTotalCost).toBe(0);
    expect(estimate.totalCost).toBe(45);
    expect(estimate.complete).toBe(true);
    expect(estimate.missingCostCount).toBe(0);
  });

  it("excludes a component with no resolvable cost from the total and flags the estimate incomplete", () => {
    const costs = new Map<string, ComponentCostInfo>([
      ["A", { averageCost: 10, suppliers: [] }],
    ]);
    const estimate = estimateProductionCost(
      "PROD-1",
      "Production One",
      "MO-00001",
      null,
      componentLines,
      [],
      costs,
      "average",
    );
    expect(estimate.componentLines[1].unitCost).toBeNull();
    expect(estimate.componentTotalCost).toBe(30); // only A, B excluded rather than treated as 0
    expect(estimate.missingCostCount).toBe(1);
    expect(estimate.complete).toBe(false);
  });

  it("adds resource cost as reported by the order — not re-priced by basis, and a missing resource cost doesn't flag the estimate incomplete", () => {
    const costs = new Map<string, ComponentCostInfo>([
      ["A", { averageCost: 10, suppliers: [] }],
      ["B", { averageCost: 5, suppliers: [] }],
    ]);
    const resourceLines: ProductionResourceLine[] = [
      {
        resourceCode: "LAB1",
        resourceName: "Labour",
        quantity: 1,
        cost: 20,
        totalCost: 20,
      },
      {
        resourceCode: "MACH1",
        resourceName: "Machine",
        quantity: 2,
        cost: null,
        totalCost: null,
      },
    ];
    const estimate = estimateProductionCost(
      "PROD-1",
      "Production One",
      "MO-00001",
      null,
      componentLines,
      resourceLines,
      costs,
      "average",
    );
    expect(estimate.componentTotalCost).toBe(45);
    expect(estimate.resourceTotalCost).toBe(20); // MACH1's null totalCost contributes 0, not excluded/flagged
    expect(estimate.totalCost).toBe(65);
    expect(estimate.missingCostCount).toBe(0); // resources never affect this — components are complete
    expect(estimate.complete).toBe(true);
  });

  it("treats an empty Resources array as a legitimate zero, not missing", () => {
    const costs = new Map<string, ComponentCostInfo>([
      ["A", { averageCost: 10, suppliers: [] }],
      ["B", { averageCost: 5, suppliers: [] }],
    ]);
    const estimate = estimateProductionCost(
      "PROD-1",
      "Production One",
      "MO-00001",
      null,
      componentLines,
      [],
      costs,
      "average",
    );
    expect(estimate.resourceLines).toHaveLength(0);
    expect(estimate.resourceTotalCost).toBe(0);
  });

  it("reports totalCost as null when there are no component or resource lines at all", () => {
    const estimate = estimateProductionCost(
      "PROD-EMPTY",
      "Empty Production",
      "MO-00001",
      null,
      [],
      [],
      new Map(),
      "average",
    );
    expect(estimate.totalCost).toBeNull();
    expect(estimate.componentTotalCost).toBeNull();
    expect(estimate.resourceTotalCost).toBe(0);
  });

  it("carries the source order number and completion date through unchanged", () => {
    const estimate = estimateProductionCost(
      "PROD-1",
      "Production One",
      "MO-00042",
      "2026-03-30T00:00:00",
      [],
      [],
      new Map(),
      "latest",
    );
    expect(estimate.sourceOrderNumber).toBe("MO-00042");
    expect(estimate.sourceOrderCompletionDate).toBe("2026-03-30T00:00:00");
    expect(estimate.basis).toBe("latest");
  });
});
