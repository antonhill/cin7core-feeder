import type { SheetExport } from "@/reports/export-xlsx";
import type { SupplierPlanLine } from "@/reports/supplier-planner/build";

const HEADER = [
  "Supplier",
  "Product",
  "SKU",
  "Location",
  "Lead",
  "Safety",
  "Currency",
  "Latest Price",
  "Qty on Hand",
  "On Order",
  "Total Out",
  "Reorder At",
  "Suggested Qty",
  "Mover",
  "Status",
  "Needs Reorder",
];

/** Mirrors the on-screen grouped-by-supplier table, flattened to one row per line — same "what you see is what you export" convention as Stock Health's/Reorder Report's exports. */
export function buildSupplierPlanSheet(lines: SupplierPlanLine[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const l of lines) {
    data.push([
      l.supplierName,
      l.productName,
      l.productSku,
      l.locationName ?? "All locations",
      l.lead,
      l.safety,
      l.currency ?? "",
      l.cost ?? "",
      l.onHand,
      l.onOrder,
      l.totalOut,
      l.threshold,
      l.suggestedQty,
      l.moverCategory,
      l.status,
      l.needsReorder ? "Yes" : "No",
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}
