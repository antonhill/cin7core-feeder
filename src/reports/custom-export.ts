import type { SheetExport } from "@/reports/export-xlsx";
import type { CustomReportResult } from "@/reports/custom/aggregate";

/**
 * The one export builder in this codebase with a dynamic header row — every
 * other report's columns are fixed, this one's are whatever the client chose
 * (dimensionLabels first, then measureLabels), same SheetExport shape as
 * everything else.
 */
export function buildCustomReportSheet(dimensionLabels: string[], measureLabels: string[], result: CustomReportResult): SheetExport {
  const data: (string | number)[][] = [[...dimensionLabels, ...measureLabels]];

  for (const row of result.rows) {
    data.push([...row.dimensionValues, ...row.measureValues]);
  }

  const totalRow: (string | number)[] = dimensionLabels.length
    ? ["Total", ...Array(dimensionLabels.length - 1).fill(""), ...result.totals]
    : ["Total", ...result.totals];
  data.push(totalRow);

  return { data, merges: [], headerRowCount: 1 };
}
