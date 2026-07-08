import type { SheetExport } from "@/reports/export-xlsx";
import type { ProductionCostEstimate } from "@/costing/production-estimate";

const HEADER = [
  "Product SKU",
  "Product Name",
  "Source Order",
  "Line Type",
  "SKU / Resource Code",
  "Name",
  "Quantity",
  "Wastage Qty",
  "Cost Basis",
  "Unit Cost",
  "Line Cost",
  "Cost Available?",
];

const BASIS_LABEL: Record<ProductionCostEstimate["basis"], string> = {
  average: "Average Cost",
  latest: "Latest Cost",
  fixed: "Fixed Cost",
};

/**
 * Per-product detail: every Component line (re-priced under the chosen
 * basis) plus every Resource line (as reported by the source Manufacture
 * Order — not basis-driven, see costing/production-estimate.ts), then a
 * synthetic TOTAL row — same self-auditing pattern as the Assembly cost
 * estimate export.
 */
export function buildProductionCostEstimateSheet(
  estimates: ProductionCostEstimate[],
): SheetExport {
  const data: (string | number)[][] = [HEADER];

  for (const estimate of estimates) {
    const basisLabel = BASIS_LABEL[estimate.basis];
    for (const line of estimate.componentLines) {
      data.push([
        estimate.productSku,
        estimate.productName,
        estimate.sourceOrderNumber,
        "Component",
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
    for (const line of estimate.resourceLines) {
      data.push([
        estimate.productSku,
        estimate.productName,
        estimate.sourceOrderNumber,
        "Resource",
        line.resourceCode,
        line.resourceName,
        line.quantity,
        "",
        "As reported by order",
        line.cost ?? "N/A",
        line.totalCost ?? "N/A",
        line.cost !== null ? "Yes" : "No",
      ]);
    }
    data.push([
      estimate.productSku,
      estimate.productName,
      estimate.sourceOrderNumber,
      "TOTAL",
      "",
      "",
      "",
      "",
      basisLabel,
      "",
      estimate.totalCost ?? "N/A",
      estimate.complete
        ? "Yes"
        : `Incomplete (${estimate.missingCostCount} missing)`,
    ]);
  }

  return { data, merges: [], headerRowCount: 1 };
}

const SUMMARY_HEADER = [
  "Product SKU",
  "Product Name",
  "Source Order",
  "Cost Basis",
  "Components",
  "Resources",
  "Component Cost",
  "Resource Cost",
  "Total Production Cost",
  "Cost Available?",
];

/** One row per Production BOM product — just the totals, no line detail. */
export function buildProductionCostEstimateSummarySheet(
  estimates: ProductionCostEstimate[],
): SheetExport {
  const data: (string | number)[][] = [SUMMARY_HEADER];

  for (const estimate of estimates) {
    data.push([
      estimate.productSku,
      estimate.productName,
      estimate.sourceOrderNumber,
      BASIS_LABEL[estimate.basis],
      estimate.componentLines.length,
      estimate.resourceLines.length,
      estimate.componentTotalCost ?? "N/A",
      estimate.resourceTotalCost,
      estimate.totalCost ?? "N/A",
      estimate.complete
        ? "Yes"
        : `Incomplete (${estimate.missingCostCount} missing)`,
    ]);
  }

  return { data, merges: [], headerRowCount: 1 };
}
