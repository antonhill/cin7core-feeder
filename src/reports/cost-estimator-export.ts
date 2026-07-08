import type { SheetExport } from "@/reports/export-xlsx";
import type { AssemblyCostEstimate } from "@/costing/estimate";

const HEADER = [
  "Assembly SKU",
  "Assembly Name",
  "Component SKU",
  "Component Name",
  "Quantity",
  "Wastage Qty",
  "Cost Basis",
  "Unit Cost",
  "Line Cost",
  "Cost Available?",
];

const BASIS_LABEL: Record<AssemblyCostEstimate["basis"], string> = {
  average: "Average Cost",
  latest: "Latest Cost",
  fixed: "Fixed Cost",
};

/**
 * Per-assembly-per-component detail, not just totals — mirrors the existing
 * Assemblies report's expandable planned/actual pattern, flattened for a
 * spreadsheet. Each assembly group gets a synthetic TOTAL row (same
 * subtotal-row technique buildPivotSheet already uses) so the export is
 * self-auditing: you can see exactly which lines fed the total, and whether
 * any were excluded for missing cost data rather than silently rolled in.
 */
export function buildCostEstimateSheet(estimates: AssemblyCostEstimate[]): SheetExport {
  const data: (string | number)[][] = [HEADER];

  for (const estimate of estimates) {
    const basisLabel = BASIS_LABEL[estimate.basis];
    for (const line of estimate.lines) {
      data.push([
        estimate.assemblySku,
        estimate.assemblyName,
        line.componentSku,
        line.componentName,
        line.quantity,
        line.wastageQuantity,
        basisLabel,
        line.unitCost ?? "N/A",
        line.lineCost ?? "N/A",
        line.unitCost !== null ? "Yes" : "No",
      ]);
    }
    data.push([
      estimate.assemblySku,
      estimate.assemblyName,
      "",
      "TOTAL",
      "",
      "",
      basisLabel,
      "",
      estimate.totalCost ?? "N/A",
      estimate.complete ? "Yes" : `Incomplete (${estimate.missingCostCount} missing)`,
    ]);
  }

  return { data, merges: [], headerRowCount: 1 };
}

const SUMMARY_HEADER = ["Assembly SKU", "Assembly Name", "Cost Basis", "Components", "Total Production Cost", "Cost Available?"];

/**
 * One row per finished good — just the assembly-level total, no component
 * breakdown. For someone who only wants "what does each finished good cost
 * to produce" without the per-line audit trail buildCostEstimateSheet gives.
 */
export function buildCostEstimateSummarySheet(estimates: AssemblyCostEstimate[]): SheetExport {
  const data: (string | number)[][] = [SUMMARY_HEADER];

  for (const estimate of estimates) {
    data.push([
      estimate.assemblySku,
      estimate.assemblyName,
      BASIS_LABEL[estimate.basis],
      estimate.lines.length,
      estimate.totalCost ?? "N/A",
      estimate.complete ? "Yes" : `Incomplete (${estimate.missingCostCount} missing)`,
    ]);
  }

  return { data, merges: [], headerRowCount: 1 };
}
