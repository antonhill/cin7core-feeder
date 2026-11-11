import type { SheetExport } from "@/reports/export-xlsx";
import { DATA_QUALITY_LABEL, LINE_STATUS_LABEL, type PoQuantityRow } from "@/reports/po-quantity-comparison";

const HEADER = [
  "Instance",
  "PO Number",
  "Supplier",
  "Order Date",
  "PO Status",
  "SKU",
  "Description",
  "Order Lines Merged",
  "Qty Ordered",
  "Qty Received",
  "Outstanding",
  "Line Status",
  "Not On Order",
  "Drop Ship",
  "Data Quality",
  "Detail Last Synced",
];

/**
 * Mirrors the on-screen rows exactly (same objects the page filters/sorts).
 * Incomplete POs export BLANK quantity cells with an explicit Data Quality
 * label — never zero — and negative outstanding (over-receipt) is exported
 * as-is.
 */
export function buildPoQuantitySheet(rows: PoQuantityRow[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const r of rows) {
    data.push([
      r.instanceName,
      r.orderNumber ?? "",
      r.supplierName ?? "",
      r.orderDate ?? "",
      r.poStatus ?? "",
      r.sku ?? "",
      r.productName ?? "",
      r.orderLineCount,
      r.ordered ?? "",
      r.received ?? "",
      r.outstanding ?? "",
      r.lineStatus ? LINE_STATUS_LABEL[r.lineStatus] : "",
      r.notOnOrder ? "Yes" : "",
      r.isDropShip ? "Yes" : "",
      DATA_QUALITY_LABEL[r.dataQuality],
      r.detailSyncedAt ?? "",
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}
