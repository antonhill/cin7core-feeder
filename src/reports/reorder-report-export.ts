import type { SheetExport } from "@/reports/export-xlsx";
import type { ReorderReportRow } from "@/reports/query";

const HEADER = ["Product", "SKU", "Weeks of Stock", "Qty on Hand", "On Order", "Reorder At", "Avg Unit Cost", "Mover", "Status", "Needs Reorder"];

/** Mirrors the on-screen table exactly — same "what you see is what you export" convention as Stock Health's export. */
export function buildReorderReportSheet(rows: ReorderReportRow[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const r of rows) {
    data.push([
      r.product_name ?? r.product_sku,
      r.product_sku,
      r.weeks_of_cover ?? "",
      r.on_hand,
      r.on_order,
      r.reorder_threshold,
      r.avg_unit_cost ?? "",
      r.mover_category,
      r.status,
      r.needs_reorder ? "Yes" : "No",
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}
