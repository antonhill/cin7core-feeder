import type { SheetExport } from "@/reports/export-xlsx";
import type { StockHealthRow } from "@/reports/query";

const HEADER = ["Product", "SKU", "On Hand", "Available", "Stock Value", "Total Out", "Days of Cover", "Mover Category", "Status"];

/** Mirrors the on-screen table exactly — same "what you see is what you export" convention as every other report here. */
export function buildStockHealthSheet(rows: StockHealthRow[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const r of rows) {
    data.push([
      r.product_name ?? r.product_sku,
      r.product_sku,
      r.on_hand,
      r.available,
      r.stock_value,
      r.total_out,
      r.days_of_cover ?? "",
      r.mover_category,
      r.status,
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}
