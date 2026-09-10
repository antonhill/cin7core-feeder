import { compareNullable, type SortDirection } from "../sortable-table";
import type { OrderFulfillmentRow } from "@/reports/query";

/** Every column the table renders. Lives here rather than in page.tsx so the parity tests can name a sort column without importing a client component. */
export type OrderTableColumn =
  | "select"
  | "order"
  | "shipBy"
  | "picking"
  | "packing"
  | "shipping"
  | "invoice"
  | "invoiceNumbers"
  | "payment"
  | "pickableNow"
  | "readyToInvoiceQty"
  | "readyToInvoiceFulfilments"
  | "boxLabelQty"
  | "boxLabelAction"
  | "paidInvoice";


/**
 * The sort contract this table has always had, kept as the single reference
 * definition now that sorting happens in SQL (migration 0091).
 *
 * The page no longer calls these — report_order_fulfillment_queue_page_json
 * and _all_page_json do the ordering, because a page cannot be sliced
 * correctly until it has been sorted. They stay here because the SQL has to
 * MATCH them exactly, and the parity tests assert that against real data
 * rather than trusting the two to have been written the same way.
 *
 * Anything that changes here must change in the SQL's `sort_txt`/`sort_num`
 * CASE arms and its ORDER BY, and the parity test is what will tell you.
 */
export function orderTableSortValue(column: OrderTableColumn, row: OrderFulfillmentRow): string | number | null {
  switch (column) {
    case "order":
      return row.order_number ?? row.customer_name;
    case "shipBy":
      return row.ship_by;
    case "picking":
      return row.combined_picking_status;
    case "packing":
      return row.combined_packing_status;
    case "shipping":
      return row.combined_shipping_status;
    case "invoice":
      return row.combined_invoice_status;
    case "invoiceNumbers":
      return row.invoice_numbers;
    case "payment":
      return row.combined_payment_status;
    case "pickableNow":
      return row.total_pickable_qty;
    case "readyToInvoiceQty":
      return row.total_ready_to_invoice_qty;
    case "readyToInvoiceFulfilments":
      return row.ready_to_invoice_fulfilment_numbers;
    case "boxLabelQty":
      return row.total_ready_for_box_label_qty;
    case "paidInvoice":
      return row.paid_amount;
    default:
      return null;
  }
}

/**
 * The full row comparator the table used: compareNullable on the column's
 * sort value, then the whole result negated for `desc`.
 *
 * THAT NEGATION IS THE SUBTLE PART. compareNullable's own docstring says
 * "nulls sort last regardless of direction" — but the page negated its
 * return value wholesale, so descending actually put nulls FIRST. The
 * docstring describes compareNullable in isolation; this is what the table
 * really did, and it is what the SQL has to reproduce. A parity test caught
 * the difference after the SQL was first written to match the docstring.
 *
 * The tiebreak is what the SQL reproduces: JavaScript's sort is stable, so
 * ties previously kept the order report_order_fulfillment returned them in
 * — which is exactly `(ship_by is null), ship_by, cin7_sale_id`.
 */
export function compareOrderRows(
  column: OrderTableColumn | null,
  direction: SortDirection
): (a: OrderFulfillmentRow, b: OrderFulfillmentRow) => number {
  return (a, b) => {
    if (column) {
      const cmp = compareNullable(orderTableSortValue(column, a), orderTableSortValue(column, b));
      // Negated wholesale for desc — including compareNullable's nulls-last,
      // which is why desc puts nulls first. Matches the page verbatim.
      if (cmp !== 0) return direction === "asc" ? cmp : -cmp;
    }
    // Priority-queue tiebreak: undated last, then by ship_by, then a stable id.
    const aNull = a.ship_by === null ? 1 : 0;
    const bNull = b.ship_by === null ? 1 : 0;
    if (aNull !== bNull) return aNull - bNull;
    if (a.ship_by !== b.ship_by) return (a.ship_by ?? "") < (b.ship_by ?? "") ? -1 : 1;
    return a.cin7_sale_id < b.cin7_sale_id ? -1 : a.cin7_sale_id > b.cin7_sale_id ? 1 : 0;
  };
}
