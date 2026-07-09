import type { SheetExport } from "@/reports/export-xlsx";
import type { CustomReportResult } from "@/reports/custom/aggregate";

/**
 * The one export builder in this codebase with a dynamic header row — every
 * other report's columns are fixed, this one's are whatever the client chose
 * (dimensionLabels first, then measureLabels), same SheetExport shape as
 * everything else.
 */
/** A ratio measure (e.g. Margin %) reports null rather than 0 when it can't be meaningfully computed (see RatioMeasureDef) — rendered as a blank cell, not a false "0". */
function cell(value: number | null): string | number {
  return value ?? "";
}

export function buildCustomReportSheet(dimensionLabels: string[], measureLabels: string[], result: CustomReportResult): SheetExport {
  const data: (string | number)[][] = [[...dimensionLabels, ...measureLabels]];

  for (const row of result.rows) {
    data.push([...row.dimensionValues, ...row.measureValues.map(cell)]);
  }

  const totalRow: (string | number)[] = dimensionLabels.length
    ? ["Total", ...Array(dimensionLabels.length - 1).fill(""), ...result.totals.map(cell)]
    : ["Total", ...result.totals.map(cell)];
  data.push(totalRow);

  return { data, merges: [], headerRowCount: 1 };
}
