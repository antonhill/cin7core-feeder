import type { SheetExport } from "@/reports/export-xlsx";
import type { Cin7FinishedGoodsListEntry } from "@/cin7/finished-goods";

const HEADER = ["Assembly #", "Product", "SKU", "Status", "Date", "Quantity", "Total Cost"];

/** Mirrors the on-screen table exactly (same columns, same rows as whatever's currently filtered/searched) — same "what you see is what you export" convention as the Cost Estimator and Sales report exports. */
export function buildAssembliesSheet(entries: Cin7FinishedGoodsListEntry[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const entry of entries) {
    const quantity = entry.Quantity ?? 0;
    const totalCost = quantity * (entry.UnitCost ?? 0);
    data.push([
      entry.AssemblyNumber ?? "",
      entry.ProductName ?? "",
      entry.ProductCode ?? "",
      entry.Status ?? "",
      entry.Date ? entry.Date.slice(0, 10) : "",
      quantity,
      totalCost,
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}
