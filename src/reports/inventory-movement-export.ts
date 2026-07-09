import type { SheetExport } from "@/reports/export-xlsx";
import type { InventoryMovementRow } from "@/reports/query";

const HEADER = [
  "Product",
  "SKU",
  "Purchased In",
  "Assembly In",
  "Total In",
  "Sold Out",
  "Consumed Out",
  "Total Out",
  "Net Change",
  "Mover Category",
];

/** Mirrors the on-screen table exactly — same "what you see is what you export" convention as the Sales/Assemblies exports. */
export function buildInventoryMovementSheet(rows: InventoryMovementRow[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const r of rows) {
    data.push([
      r.product_name ?? r.product_sku,
      r.product_sku,
      r.qty_in_purchases,
      r.qty_in_assemblies,
      r.total_in,
      r.qty_out_sales,
      r.qty_out_consumption,
      r.total_out,
      r.net_change,
      r.mover_category,
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}
