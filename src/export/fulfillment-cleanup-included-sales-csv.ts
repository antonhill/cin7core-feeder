import { toCsv } from "@/export/csv-format";
import type { BackorderedSale } from "@/app/reports/fulfillment-cleanup/actions";

/**
 * An audit-trail export, not a Cin7 import template: which backordered
 * sales a given Fulfillment Cleanup run assumed would become fulfillable
 * (i.e. every backordered sale the user did NOT exclude) — for keeping a
 * record of what a specific Bulk Stock Adjustment import was meant to
 * unblock, separate from the adjustment file itself.
 */
const HEADER = ["Order Number", "Customer", "Customer Reference", "Order Date", "Backorder Qty"];

export function buildIncludedSalesCsv(sales: BackorderedSale[]): string {
  const rows = sales.map((s) => [s.orderNumber, s.customerName, s.customerReference, s.orderDate, s.totalBackorderQty]);
  return toCsv([HEADER, ...rows]);
}
