import type { SheetExport } from "@/reports/export-xlsx";
import type { OrderFulfillmentRow } from "@/reports/query";
import { resolveOrderFulfillmentExportColumns } from "@/reports/order-fulfillment-export-columns";

/**
 * Mirrors whichever tab/filter is currently on screen (Pick Today / Ship
 * Today / full list) — same "what you see is what you export" convention as
 * every other report here. `columnKeys` (P5.5) is the user's column-picker
 * selection; omitted/empty falls back to the original fixed 15-column set,
 * so nothing changes for anyone who hasn't customized their columns.
 */
export function buildOrderFulfillmentSheet(rows: OrderFulfillmentRow[], columnKeys?: string[]): SheetExport {
  const columns = resolveOrderFulfillmentExportColumns(columnKeys);
  const data: (string | number)[][] = [columns.map((c) => c.label)];
  for (const r of rows) {
    data.push(columns.map((c) => c.get(r)));
  }
  return { data, merges: [], headerRowCount: 1 };
}
