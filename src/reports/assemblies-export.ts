import type { SheetExport } from "@/reports/export-xlsx";
import type { Cin7FinishedGoodsListEntry, Cin7FinishedGoodsDetail } from "@/cin7/finished-goods";

const HEADER = ["Assembly #", "Product", "SKU", "Status", "Date", "Quantity", "Total Cost"];

/** Mirrors the on-screen table exactly (same columns, same rows as whatever's currently filtered/searched) — same "what you see is what you export" convention as the Cost Estimator and Sales report exports. */
export function buildAssembliesSheet(entries: Cin7FinishedGoodsListEntry[]): SheetExport {
  const data: (string | number)[][] = [HEADER];
  for (const entry of entries) {
    const quantity = entry.Quantity ?? 0;
    const totalCost = quantity * (entry.UnitCost ?? 0);
    data.push([
      entry.AssemblyNumber ?? "",
      entry.ProductName ?? "",
      entry.ProductCode ?? "",
      entry.Status ?? "",
      entry.Date ? entry.Date.slice(0, 10) : "",
      quantity,
      totalCost,
    ]);
  }
  return { data, merges: [], headerRowCount: 1 };
}

const DETAIL_HEADER = [
  "Assembly #",
  "Product",
  "SKU",
  "Line Type",
  "Component",
  "Component SKU",
  "Batch/SN",
  "Quantity",
  "Unit",
  "Unit Cost",
  "Line Cost",
];

export interface AssemblyWithDetail {
  entry: Cin7FinishedGoodsListEntry;
  detail: Cin7FinishedGoodsDetail | undefined;
  detailError: string | undefined;
}

/**
 * Per-assembly-per-component detail, mirroring the on-screen expandable
 * panel's two tables (planned OrderLines, actual PickLines) — flattened for
 * a spreadsheet, one row per component line, with an Estimated/Actual TOTAL
 * row per assembly (same subtotal-row convention as the Cost Estimator
 * export). An assembly whose detail failed to fetch (or was never fetched)
 * gets a single "Detail unavailable" row rather than being silently dropped
 * — so a partial export is visibly partial, not mistaken for complete.
 */
export function buildAssembliesDetailSheet(rows: AssemblyWithDetail[]): SheetExport {
  const data: (string | number)[][] = [DETAIL_HEADER];

  for (const { entry, detail, detailError } of rows) {
    const assemblyNumber = entry.AssemblyNumber ?? "";
    const product = entry.ProductName ?? "";
    const sku = entry.ProductCode ?? "";

    if (!detail) {
      data.push([assemblyNumber, product, sku, "", detailError ? `Detail unavailable: ${detailError}` : "Detail not fetched", "", "", "", "", "", ""]);
      continue;
    }

    const orderLines = detail.OrderLines ?? [];
    const pickLines = detail.PickLines ?? [];

    for (const line of orderLines) {
      data.push([
        assemblyNumber,
        product,
        sku,
        "Planned",
        line.Name ?? "",
        line.ProductCode ?? "",
        "",
        line.TotalQuantity ?? line.Quantity ?? 0,
        line.Unit ?? "",
        "",
        line.TotalCost ?? 0,
      ]);
    }
    const estimatedTotal = orderLines.reduce((sum, l) => sum + (l.TotalCost ?? 0), 0);
    data.push([assemblyNumber, product, sku, "TOTAL (Estimated)", "", "", "", "", "", "", estimatedTotal]);

    for (const line of pickLines) {
      const quantity = line.Quantity ?? 0;
      const cost = line.Cost ?? 0;
      data.push([assemblyNumber, product, sku, "Actual", line.Name ?? "", line.ProductCode ?? "", line.BatchSN ?? "", quantity, line.Unit ?? "", cost, quantity * cost]);
    }
    const actualTotal = pickLines.reduce((sum, l) => sum + (l.Quantity ?? 0) * (l.Cost ?? 0), 0);
    data.push([assemblyNumber, product, sku, "TOTAL (Actual)", "", "", "", "", "", "", actualTotal]);
  }

  return { data, merges: [], headerRowCount: 1 };
}
