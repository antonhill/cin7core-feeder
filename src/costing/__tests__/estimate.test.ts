import { describe, expect, it } from "vitest";
import { resolveComponentCost, estimateAssemblyCost, type ComponentCostInfo } from "@/costing/estimate";
import type { CostEstimatorBomLine } from "@/cin7/product-cost";

describe("resolveComponentCost", () => {
  it("returns the average cost for the average basis", () => {
    const info: ComponentCostInfo = { averageCost: 12.5, suppliers: [] };
    expect(resolveComponentCost(info, "average")).toBe(12.5);
  });

  it("treats a literal 0 as missing, not a real zero cost — Cin7's own not-configured sentinel", () => {
    const info: ComponentCostInfo = { averageCost: 0, suppliers: [] };
    expect(resolveComponentCost(info, "average")).toBeNull();
  });

  it("returns null for latest/fixed when there are no suppliers at all", () => {
    const info: ComponentCostInfo = { averageCost: 5, suppliers: [] };
    expect(resolveComponentCost(info, "latest")).toBeNull();
    expect(resolveComponentCost(info, "fixed")).toBeNull();
  });

  it("picks the most recently supplied entry when a component has multiple suppliers", () => {
    const info: ComponentCostInfo = {
      averageCost: null,
      suppliers: [
        { cost: 10, fixedCost: 8, lastSupplied: "2026-01-01T00:00:00" },
        { cost: 15, fixedCost: 9, lastSupplied: "2026-06-22T00:00:00" },
      ],
    };
    expect(resolveComponentCost(info, "latest")).toBe(15);
    expect(resolveComponentCost(info, "fixed")).toBe(9);
  });

  it("does not fall back to a stale supplier's cost when the most recent supplier's value is missing", () => {
    const info: ComponentCostInfo = {
      averageCost: null,
      suppliers: [
        { cost: 10, fixedCost: null, lastSupplied: "2026-01-01T00:00:00" },
        { cost: 0, fixedCost: null, lastSupplied: "2026-06-22T00:00:00" },
      ],
    };
    expect(resolveComponentCost(info, "latest")).toBeNull();
  });

  it("returns null entirely when no cost info is known for the component", () => {
    expect(resolveComponentCost(undefined, "average")).toBeNull();
  });
});

describe("estimateAssemblyCost", () => {
  const lines: CostEstimatorBomLine[] = [
    { componentSku: "A", componentName: "Widget A", quantity: 2, wastageQuantity: 1 },
    { componentSku: "B", componentName: "Widget B", quantity: 3, wastageQuantity: 0 },
  ];

  it("sums quantity-plus-wastage times unit cost per line", () => {
    const costs = new Map<string, ComponentCostInfo>([
      ["A", { averageCost: 10, suppliers: [] }],
      ["B", { averageCost: 5, suppliers: [] }],
    ]);
    const estimate = estimateAssemblyCost("ASM-1", "Assembly One", lines, costs, "average");
    // A: (2 + 1) * 10 = 30, B: 3 * 5 = 15
    expect(estimate.lines[0].lineCost).toBe(30);
    expect(estimate.lines[1].lineCost).toBe(15);
    expect(estimate.totalCost).toBe(45);
    expect(estimate.complete).toBe(true);
    expect(estimate.missingCostCount).toBe(0);
  });

  it("excludes a component with no resolvable cost from the total and flags the estimate incomplete", () => {
    const costs = new Map<string, ComponentCostInfo>([["A", { averageCost: 10, suppliers: [] }]]);
    // B is absent from the map entirely — never seen in the catalog fetch.
    const estimate = estimateAssemblyCost("ASM-1", "Assembly One", lines, costs, "average");
    expect(estimate.lines[1].unitCost).toBeNull();
    expect(estimate.lines[1].lineCost).toBeNull();
    expect(estimate.totalCost).toBe(30); // only A's line, B excluded rather than treated as 0
    expect(estimate.missingCostCount).toBe(1);
    expect(estimate.complete).toBe(false);
  });

  it("reports totalCost as null for an assembly with no BOM lines at all", () => {
    const estimate = estimateAssemblyCost("ASM-EMPTY", "Empty Assembly", [], new Map(), "average");
    expect(estimate.totalCost).toBeNull();
    expect(estimate.lines).toHaveLength(0);
  });
});
