import type { SheetExport } from "@/reports/export-xlsx";
import type { OrderFulfillmentRow } from "@/reports/query";

const HEADER = [
  "Order #",
  "Customer",
  "Ship By",
  "Overdue?",
  "Picking",
  "Packing",
  "Shipping",
  "Invoice",
  "Payment",
  "Ordered Qty",
  "Backorder Qty",
  "Pickable Now",
  "Picked So Far",
  "Invoice Amount",
  "Paid",
];

/** Mirrors whichever tab/filter is currently on screen (Pick Today / Ship Today / full list) — same "what you see is what you export" convention as every other report here. */
export function buildOrderFulfillmentSheet(rows: OrderFulfillmentRow[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const r of rows) {
    data.push([
      r.order_number ?? r.cin7_sale_id,
      r.customer_name ?? "",
      r.ship_by ?? "",
      r.is_overdue ? "Overdue" : "",
      r.combined_picking_status ?? "",
      r.combined_packing_status ?? "",
      r.combined_shipping_status ?? "",
      r.combined_invoice_status ?? "",
      r.combined_payment_status ?? "",
      r.total_ordered_qty,
      r.total_backorder_qty,
      r.total_pickable_qty,
      r.total_picked_qty,
      r.invoice_amount,
      r.paid_amount,
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}
