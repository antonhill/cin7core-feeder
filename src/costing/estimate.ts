import type { Cin7ProductSupplier, CostEstimatorBomLine } from "@/cin7/product-cost";

export type CostBasis = "average" | "latest" | "fixed";

export const COST_BASIS_OPTIONS: { value: CostBasis; label: string }[] = [
  { value: "average", label: "Average Cost" },
  { value: "latest", label: "Latest Cost" },
  { value: "fixed", label: "Fixed Cost" },
];

export interface ComponentCostInfo {
  averageCost: number | null;
  suppliers: Cin7ProductSupplier[];
}

export interface ComponentCostResult {
  componentSku: string;
  componentName: string;
  quantity: number;
  wastageQuantity: number;
  unitCost: number | null;
  lineCost: number | null;
}

export interface AssemblyCostEstimate {
  assemblySku: string;
  assemblyName: string;
  basis: CostBasis;
  lines: ComponentCostResult[];
  totalCost: number | null;
  missingCostCount: number;
  complete: boolean;
}

/** Cin7's own "not configured" sentinel across every cost field checked live (AverageCost, Suppliers[].Cost, Suppliers[].FixedCost all default to exactly 0 rather than being omitted when unset — confirmed 2026-07-08 via the cost-basis field survey, 41 of 50 real products had AverageCost=0). Treating a literal 0 as a real cost would show misleadingly "free" line items instead of the missing data they actually represent. */
function nonZero(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && value !== 0 ? value : null;
}

/** When a component has more than one supplier, "Latest Cost"/"Fixed Cost" use the one supplied most recently — picking a different (stale) supplier's value instead would misrepresent what "latest" means, even if that supplier's own Cost/FixedCost happens to be set. */
function mostRecentSupplier(suppliers: Cin7ProductSupplier[]): Cin7ProductSupplier | undefined {
  if (suppliers.length === 0) return undefined;
  return [...suppliers].sort((a, b) => (b.lastSupplied ?? "").localeCompare(a.lastSupplied ?? ""))[0];
}

/**
 * Resolves one component's per-unit cost under the chosen basis. Returns
 * `null` (not a fallback to 0 or to a different basis) whenever that basis
 * genuinely has no value for this component — see estimateAssemblyCost's own
 * comment for why a missing cost is surfaced as incomplete rather than
 * silently substituted.
 */
export function resolveComponentCost(info: ComponentCostInfo | undefined, basis: CostBasis): number | null {
  if (!info) return null;
  if (basis === "average") return nonZero(info.averageCost);

  const supplier = mostRecentSupplier(info.suppliers);
  if (!supplier) return null;
  return basis === "latest" ? nonZero(supplier.cost) : nonZero(supplier.fixedCost);
}

/**
 * Rolls up one assembly's BOM under a single cost basis. A component with no
 * resolvable cost is marked "N/A" and excluded from the total (not treated
 * as free) — and the whole estimate is flagged incomplete (`complete: false`)
 * so a partial total is never mistaken for a full one. Wastage is added to
 * the base quantity — `WastageQuantity` reads as the already-resolved
 * absolute wastage amount (an alternate input mode to `WastagePercent`, not
 * a second additive source), so summing avoids double-counting.
 */
export function estimateAssemblyCost(
  assemblySku: string,
  assemblyName: string,
  lines: CostEstimatorBomLine[],
  costsBySku: Map<string, ComponentCostInfo>,
  basis: CostBasis
): AssemblyCostEstimate {
  let totalCost = 0;
  let missingCostCount = 0;

  const resultLines: ComponentCostResult[] = lines.map((line) => {
    const unitCost = resolveComponentCost(costsBySku.get(line.componentSku), basis);
    const effectiveQuantity = line.quantity + line.wastageQuantity;
    const lineCost = unitCost !== null ? unitCost * effectiveQuantity : null;
    if (lineCost === null) missingCostCount++;
    else totalCost += lineCost;
    return {
      componentSku: line.componentSku,
      componentName: line.componentName,
      quantity: line.quantity,
      wastageQuantity: line.wastageQuantity,
      unitCost,
      lineCost,
    };
  });

  return {
    assemblySku,
    assemblyName,
    basis,
    lines: resultLines,
    totalCost: resultLines.length > 0 ? totalCost : null,
    missingCostCount,
    complete: missingCostCount === 0,
  };
}
