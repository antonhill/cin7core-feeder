import { toSanitizedCsv } from "@/export/csv-format";
import type { BackorderedSale } from "@/app/reports/fulfillment-cleanup/actions";

/**
 * An audit-trail export, not a Cin7 import template: which backordered
 * sales a given Fulfillment Cleanup run assumed would become fulfillable
 * (i.e. every backordered sale the user did NOT exclude) — for keeping a
 * record of what a specific Bulk Stock Adjustment import was meant to
 * unblock, separate from the adjustment file itself.
 *
 * Security re-audit P1-7: this is the ONE human-facing CSV export in the
 * app (every other CSV export is a Cin7 round-trip template) — uses
 * toSanitizedCsv, not toCsv, so a customer name/reference from Cin7 that
 * happens to start with =/+/-/@ can't execute as a formula when a human
 * opens this file directly in a spreadsheet app.
 */
const HEADER = ["Order Number", "Customer", "Customer Reference", "Order Date", "Backorder Qty"];

export function buildIncludedSalesCsv(sales: BackorderedSale[]): string {
  const rows = sales.map((s) => [s.orderNumber, s.customerName, s.customerReference, s.orderDate, s.totalBackorderQty]);
  return toSanitizedCsv([HEADER, ...rows]);
}
