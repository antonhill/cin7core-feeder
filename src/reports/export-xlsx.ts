import type { ProductSalesReportRow } from "@/reports/query";
import { METRIC_COLUMNS, type PivotCellValues, type PivotGrid } from "@/reports/pivot";

export interface SheetMerge {
  s: { r: number; c: number };
  e: { r: number; c: number };
}

/**
 * Framework-agnostic description of one worksheet's content — a plain
 * array-of-arrays (row-major, matching how every spreadsheet library wants
 * cell data) plus merge ranges, kept separate from any actual XLSX-writing
 * library so this stays trivially testable and reusable regardless of which
 * writer renders it (see reports/xlsx-writer.ts, server-only since it uses
 * exceljs).
 */
export interface SheetExport {
  data: (string | number)[][];
  merges: SheetMerge[];
  /** Number of leading rows to bold when rendering — 1 for the flat table, 2 or 3 for the pivot grid depending on whether Location×Category is nested. */
  headerRowCount: number;
}

/** Today's flat per-product table, unchanged — one header row, one row per product. */
export function buildFlatReportSheet(rows: ProductSalesReportRow[]): SheetExport {
  const data: (string | number)[][] = [["Product", "SKU", "Qty sold", "Revenue", "COGS", "Profit", "Margin%"]];
  for (const r of rows) {
    data.push([r.product_name ?? r.product_sku, r.product_sku, r.quantity_sold, r.revenue, r.cogs, r.profit, r.margin_percent ?? ""]);
  }
  return { data, merges: [], headerRowCount: 1 };
}

function metricRowValues(values: PivotCellValues | null): (string | number)[] {
  if (!values) return METRIC_COLUMNS.map(() => "");
  return METRIC_COLUMNS.map((col) => (col.key === "marginPercent" ? (values.marginPercent ?? "") : values[col.key]));
}

/**
 * Mirrors the pivot grid's on-screen layout: an optional top row of Location
 * group headers (merged across their span), a row of the pivoted dimension's
 * values (merged across each metric block), then the Qty/Revenue/COGS/
 * Profit/Margin% leaf labels — same 2-or-3-tier structure the page renders,
 * just as merge ranges instead of colSpan.
 */
export function buildPivotSheet(grid: PivotGrid): SheetExport {
  const span = METRIC_COLUMNS.length;
  const merges: SheetMerge[] = [];
  const data: (string | number)[][] = [];
  let r = 0;

  if (grid.columnGroups) {
    const row: (string | number)[] = [""];
    let c = 1;
    for (const group of grid.columnGroups) {
      const width = group.span * span;
      row.push(group.label, ...Array(width - 1).fill(""));
      merges.push({ s: { r, c }, e: { r, c: c + width - 1 } });
      c += width;
    }
    row.push("Total", ...Array(span - 1).fill(""));
    merges.push({ s: { r, c }, e: { r, c: c + span - 1 } });
    data.push(row);
    r++;
  }

  const midRow: (string | number)[] = [""];
  let c = 1;
  for (const col of grid.columns) {
    midRow.push(col.label, ...Array(span - 1).fill(""));
    merges.push({ s: { r, c }, e: { r, c: c + span - 1 } });
    c += span;
  }
  midRow.push("Total", ...Array(span - 1).fill(""));
  merges.push({ s: { r, c }, e: { r, c: c + span - 1 } });
  data.push(midRow);
  r++;

  const metricLabels = METRIC_COLUMNS.map((m) => m.label);
  const leafRow: (string | number)[] = ["Product"];
  for (let i = 0; i < grid.columns.length; i++) leafRow.push(...metricLabels);
  leafRow.push(...metricLabels);
  data.push(leafRow);

  for (const row of grid.rows) {
    const line: (string | number)[] = [row.productName];
    for (const col of grid.columns) line.push(...metricRowValues(row.cells[col.key]));
    line.push(...metricRowValues(row.total));
    data.push(line);
  }

  const footer: (string | number)[] = ["Total"];
  for (const col of grid.columns) footer.push(...metricRowValues(grid.totals[col.key]));
  footer.push(...metricRowValues(grid.grandTotal));
  data.push(footer);

  return { data, merges, headerRowCount: grid.columnGroups ? 3 : 2 };
}
