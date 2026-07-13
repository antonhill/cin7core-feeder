import type { AggregatedNataRow } from "@/reports/natas-report";
import type { SheetExport } from "@/reports/export-xlsx";

/** Same column set/order as the report page's default-visible columns — matches what a user looking at the on-screen table would expect to download. */
export function buildNatasReportSheet(rows: AggregatedNataRow[]): SheetExport {
  const data: (string | number)[][] = [
    [
      "Month",
      "Location",
      "Nata Type",
      "Individual Natas",
      "Revenue (ex VAT)",
      "COGS",
      "Nata COGS",
      "Nata COGS %",
      "Packaging COGS",
      "Packaging COGS %",
      "Profit",
      "Unit Profit",
      "Margin %",
    ],
  ];

  let totalNatas = 0;
  let totalRevenueExVat = 0;
  let totalFullCogs = 0;
  let totalNatCogs = 0;
  let totalPackagingCost = 0;
  let totalProfit = 0;

  for (const r of rows) {
    data.push([
      r.month,
      r.location,
      r.nataType,
      r.individualNatas,
      r.revenueExVat,
      r.fullCogs,
      r.natCogs,
      r.natCogsPercent ?? "",
      r.packagingCost,
      r.packagingCostPercent ?? "",
      r.profit,
      r.individualNatas > 0 ? r.profit / r.individualNatas : "",
      r.marginPercent ?? "",
    ]);
    totalNatas += r.individualNatas;
    totalRevenueExVat += r.revenueExVat;
    totalFullCogs += r.fullCogs;
    totalNatCogs += r.natCogs;
    totalPackagingCost += r.packagingCost;
    totalProfit += r.profit;
  }

  data.push([
    "Total",
    "",
    "",
    totalNatas,
    totalRevenueExVat,
    totalFullCogs,
    totalNatCogs,
    totalFullCogs > 0 ? (totalNatCogs / totalFullCogs) * 100 : "",
    totalPackagingCost,
    totalFullCogs > 0 ? (totalPackagingCost / totalFullCogs) * 100 : "",
    totalProfit,
    totalNatas > 0 ? totalProfit / totalNatas : "",
    totalRevenueExVat > 0 ? (totalProfit / totalRevenueExVat) * 100 : "",
  ]);

  return { data, merges: [], headerRowCount: 1 };
}
