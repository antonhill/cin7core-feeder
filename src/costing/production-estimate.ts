import {
  resolveComponentCost,
  type CostBasis,
  type ComponentCostInfo,
  type ComponentCostResult,
} from "@/costing/estimate";
import type { CostEstimatorBomLine } from "@/cin7/product-cost";
import type { ProductionResourceLine } from "@/cin7/production-order-detail";

export interface ProductionCostEstimate {
  productSku: string;
  productName: string;
  basis: CostBasis;
  sourceOrderNumber: string;
  sourceOrderCompletionDate: string | null;
  componentLines: ComponentCostResult[];
  resourceLines: ProductionResourceLine[];
  componentTotalCost: number | null;
  resourceTotalCost: number;
  totalCost: number | null;
  missingCostCount: number;
  complete: boolean;
}

/**
 * Components are real stock SKUs with their own Average/Supplier cost
 * fields, so they're re-priced under the chosen basis exactly like Assembly
 * BOM components (resolveComponentCost). Resources (labor/machine) have no
 * such basis to toggle — there's no confirmed "current resource rate"
 * endpoint, so they're shown at whatever cost the source Manufacture Order
 * itself reported. That also means a missing/zero resource cost is a
 * legitimate "no cost recorded for this run" rather than the "N/A, flags
 * the whole estimate incomplete" treatment a missing component cost gets —
 * `missingCostCount`/`complete` only ever reflect component lines.
 */
export function estimateProductionCost(
  productSku: string,
  productName: string,
  sourceOrderNumber: string,
  sourceOrderCompletionDate: string | null,
  componentBomLines: CostEstimatorBomLine[],
  resourceLines: ProductionResourceLine[],
  costsBySku: Map<string, ComponentCostInfo>,
  basis: CostBasis,
): ProductionCostEstimate {
  let componentTotalCost = 0;
  let missingCostCount = 0;

  const componentLines: ComponentCostResult[] = componentBomLines.map(
    (line) => {
      const unitCost = resolveComponentCost(
        costsBySku.get(line.componentSku),
        basis,
      );
      const effectiveQuantity = line.quantity + line.wastageQuantity;
      const lineCost = unitCost !== null ? unitCost * effectiveQuantity : null;
      if (lineCost === null) missingCostCount++;
      else componentTotalCost += lineCost;
      return {
        componentSku: line.componentSku,
        componentName: line.componentName,
        quantity: line.quantity,
        wastageQuantity: line.wastageQuantity,
        unitCost,
        lineCost,
      };
    },
  );

  const resourceTotalCost = resourceLines.reduce(
    (sum, r) => sum + (r.totalCost ?? 0),
    0,
  );
  const hasAnyLines = componentLines.length > 0 || resourceLines.length > 0;

  return {
    productSku,
    productName,
    basis,
    sourceOrderNumber,
    sourceOrderCompletionDate,
    componentLines,
    resourceLines,
    componentTotalCost: componentLines.length > 0 ? componentTotalCost : null,
    resourceTotalCost,
    totalCost: hasAnyLines ? componentTotalCost + resourceTotalCost : null,
    missingCostCount,
    complete: missingCostCount === 0,
  };
}
