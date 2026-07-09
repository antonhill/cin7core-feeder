import { toCsv } from "@/export/csv-format";
import type { FulfillmentCleanupLine } from "@/reports/fulfillment-cleanup/build";

/** Matches Cin7's own BulkUpdateStockAdjustment.csv template column-for-column, confirmed against a real sample export. */
const HEADER = [
  "Zero/NonZero",
  "Location",
  "SKU",
  "Name",
  "Bin",
  "BatchSerialNumber",
  "ExpiryDate_YYYYMMDD",
  "Quantity",
  "UnitCost",
  "Comments",
  "ReceivedDate_YYYYMMDD",
];

/** Cin7's date columns want "YYYYMMDD" with no separators, unlike the plain "YYYY-MM-DD" this app stores internally. */
function toYyyymmdd(value: string | null): string {
  return value ? value.replaceAll("-", "") : "";
}

export function buildFulfillmentCleanupCsv(lines: FulfillmentCleanupLine[]): string {
  const rows = lines.map((l) => [
    l.action,
    l.location,
    l.productSku,
    l.productName,
    l.bin,
    l.batchSn,
    toYyyymmdd(l.expiryDate),
    l.quantity,
    l.unitCost,
    l.comments,
    toYyyymmdd(l.receivedDate),
  ]);
  return toCsv([HEADER, ...rows]);
}
