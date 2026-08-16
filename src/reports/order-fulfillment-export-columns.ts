import type { OrderFulfillmentRow } from "@/reports/query";

export interface OrderFulfillmentExportColumn {
  key: string;
  label: string;
  /** Groups columns in the picker UI — purely presentational, not used by the export itself. */
  group: string;
  get: (row: OrderFulfillmentRow) => string | number;
}

function bool(value: boolean): string {
  return value ? "Yes" : "";
}

/**
 * P5.5 (LBL brief): the "full synced column set" a column-picker chooses
 * from — one entry per field on OrderFulfillmentRow. Order here is also the
 * default column order in the exported sheet, independent of picker
 * grouping. Adding a new field to OrderFulfillmentRow means adding it here
 * too — nothing else derives this list automatically.
 */
export const ORDER_FULFILLMENT_EXPORT_COLUMNS: OrderFulfillmentExportColumn[] = [
  { key: "order_number", label: "Order #", group: "Order info", get: (r) => r.order_number ?? r.cin7_sale_id },
  { key: "cin7_sale_id", label: "Cin7 Sale ID", group: "Order info", get: (r) => r.cin7_sale_id },
  { key: "instance_id", label: "Instance ID", group: "Order info", get: (r) => r.instance_id },
  { key: "customer_name", label: "Customer", group: "Order info", get: (r) => r.customer_name ?? "" },
  { key: "customer_reference", label: "Customer Reference", group: "Order info", get: (r) => r.customer_reference ?? "" },
  { key: "order_date", label: "Order Date", group: "Order info", get: (r) => r.order_date ?? "" },
  { key: "days_open", label: "Days Open", group: "Order info", get: (r) => r.days_open ?? "" },
  { key: "ship_by", label: "Ship By", group: "Order info", get: (r) => r.ship_by ?? "" },
  { key: "is_overdue", label: "Overdue?", group: "Order info", get: (r) => (r.is_overdue ? "Overdue" : "") },
  { key: "order_status", label: "Order Status", group: "Order info", get: (r) => r.order_status ?? "" },
  { key: "combined_picking_status", label: "Picking", group: "Status", get: (r) => r.combined_picking_status ?? "" },
  { key: "combined_packing_status", label: "Packing", group: "Status", get: (r) => r.combined_packing_status ?? "" },
  { key: "combined_shipping_status", label: "Shipping", group: "Status", get: (r) => r.combined_shipping_status ?? "" },
  { key: "combined_invoice_status", label: "Invoice", group: "Status", get: (r) => r.combined_invoice_status ?? "" },
  { key: "combined_payment_status", label: "Payment", group: "Status", get: (r) => r.combined_payment_status ?? "" },
  { key: "invoice_coverage_status", label: "Invoice Coverage", group: "Status", get: (r) => r.invoice_coverage_status },
  { key: "total_ordered_qty", label: "Ordered Qty", group: "Quantities", get: (r) => r.total_ordered_qty },
  { key: "total_backorder_qty", label: "Backorder Qty", group: "Quantities", get: (r) => r.total_backorder_qty },
  { key: "total_pickable_qty", label: "Pickable Now", group: "Quantities", get: (r) => r.total_pickable_qty },
  { key: "total_picked_qty", label: "Picked So Far", group: "Quantities", get: (r) => r.total_picked_qty },
  { key: "total_packed_qty", label: "Packed Qty", group: "Quantities", get: (r) => r.total_packed_qty },
  { key: "total_packed_qty_authorised", label: "Packed Qty (Authorised)", group: "Quantities", get: (r) => r.total_packed_qty_authorised },
  { key: "total_invoiced_qty", label: "Invoiced Qty", group: "Quantities", get: (r) => r.total_invoiced_qty },
  { key: "total_ready_to_invoice_qty", label: "Qty Awaiting Invoice", group: "Quantities", get: (r) => r.total_ready_to_invoice_qty },
  { key: "total_ready_for_box_label_qty", label: "Qty Ready for Label", group: "Quantities", get: (r) => r.total_ready_for_box_label_qty },
  {
    key: "total_backorder_po_outstanding_qty",
    label: "Backorder PO Outstanding Qty",
    group: "Quantities",
    get: (r) => r.total_backorder_po_outstanding_qty,
  },
  { key: "invoice_amount", label: "Invoice Amount", group: "Invoicing & Payment", get: (r) => r.invoice_amount },
  { key: "paid_amount", label: "Paid", group: "Invoicing & Payment", get: (r) => r.paid_amount },
  { key: "invoice_numbers", label: "Invoice #(s)", group: "Invoicing & Payment", get: (r) => r.invoice_numbers ?? "" },
  { key: "is_pick_today", label: "Pick Today?", group: "Queue flags", get: (r) => bool(r.is_pick_today) },
  { key: "is_ship_today", label: "Ship Today?", group: "Queue flags", get: (r) => bool(r.is_ship_today) },
  { key: "is_ready_to_invoice", label: "Ready to Invoice?", group: "Queue flags", get: (r) => bool(r.is_ready_to_invoice) },
  { key: "is_ready_for_box_label", label: "Ready for Box Label?", group: "Queue flags", get: (r) => bool(r.is_ready_for_box_label) },
  { key: "has_backorder_with_po", label: "Has Backorder With PO", group: "Queue flags", get: (r) => bool(r.has_backorder_with_po) },
  { key: "has_backorder_no_po", label: "Has Backorder With NO PO", group: "Queue flags", get: (r) => bool(r.has_backorder_no_po) },
  { key: "pick_today_hidden_by_floor", label: "Hidden From Pick Today (Floor)", group: "Queue flags", get: (r) => bool(r.pick_today_hidden_by_floor) },
  { key: "ship_today_hidden_by_floor", label: "Hidden From Ship Today (Floor)", group: "Queue flags", get: (r) => bool(r.ship_today_hidden_by_floor) },
  {
    key: "ready_to_invoice_hidden_by_floor",
    label: "Hidden From Ready to Invoice (Floor)",
    group: "Queue flags",
    get: (r) => bool(r.ready_to_invoice_hidden_by_floor),
  },
  { key: "box_label_hidden_by_floor", label: "Hidden From Box Label (Floor)", group: "Queue flags", get: (r) => bool(r.box_label_hidden_by_floor) },
  { key: "box_label_printed_at", label: "Box Label Printed At", group: "Queue flags", get: (r) => r.box_label_printed_at ?? "" },
  { key: "box_label_printed_by_email", label: "Box Label Printed By", group: "Queue flags", get: (r) => r.box_label_printed_by_email ?? "" },
];

const EXPORT_COLUMN_BY_KEY = new Map(ORDER_FULFILLMENT_EXPORT_COLUMNS.map((c) => [c.key, c]));

export function isOrderFulfillmentExportColumnKey(key: string): boolean {
  return EXPORT_COLUMN_BY_KEY.has(key);
}

/** The export's original fixed column set, in its original order — the default selection for anyone who's never customized their columns, so behavior doesn't change until a user opts in. */
export const DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS: string[] = [
  "order_number",
  "customer_name",
  "ship_by",
  "is_overdue",
  "combined_picking_status",
  "combined_packing_status",
  "combined_shipping_status",
  "combined_invoice_status",
  "combined_payment_status",
  "total_ordered_qty",
  "total_backorder_qty",
  "total_pickable_qty",
  "total_picked_qty",
  "invoice_amount",
  "paid_amount",
];

/** Resolves a saved/selected key list to real columns, in the CANONICAL registry order (not the saved order) — dropping any stale/unknown key (e.g. a field renamed or removed since the preference was saved) rather than throwing. Falls back to the default set if nothing valid remains. */
export function resolveOrderFulfillmentExportColumns(keys: string[] | undefined): OrderFulfillmentExportColumn[] {
  const requested = keys?.length ? keys : DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS;
  const resolved = ORDER_FULFILLMENT_EXPORT_COLUMNS.filter((c) => requested.includes(c.key));
  return resolved.length > 0 ? resolved : ORDER_FULFILLMENT_EXPORT_COLUMNS.filter((c) => DEFAULT_ORDER_FULFILLMENT_EXPORT_COLUMN_KEYS.includes(c.key));
}
