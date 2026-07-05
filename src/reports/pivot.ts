export type PivotMetric = "revenue" | "cogs" | "profit" | "margin_percent";
export type PivotGroupBy = "location" | "category" | "both";

/** One row of report_sales_pivot's output — location/category_code are null when that dimension wasn't grouped by. */
export interface PivotSourceRow {
  product_sku: string;
  product_name: string | null;
  location: string | null;
  category_code: string | null;
  quantity_sold: number;
  revenue: number;
  cogs: number;
  profit: number;
}

interface CellTotals {
  revenue: number;
  cogs: number;
  profit: number;
}

export interface PivotColumn {
  key: string;
  label: string;
  /** Set only in "both" mode — the parent Location this Category column sits under. */
  groupLabel?: string;
}

export interface PivotRow {
  productSku: string;
  productName: string;
  cells: Record<string, number | null>;
  total: number | null;
}

export interface PivotGrid {
  columns: PivotColumn[];
  /** Top-level header groups (Location), non-null only in "both" mode. */
  columnGroups: { label: string; span: number }[] | null;
  rows: PivotRow[];
  totals: Record<string, number | null>;
  grandTotal: number | null;
}

const UNSPECIFIED = "(none)";
const ZERO_TOTALS: CellTotals = { revenue: 0, cogs: 0, profit: 0 };

/**
 * Margin% is never additive — a row/column/grand total re-derives it from
 * the summed revenue/profit underneath, rather than summing or averaging the
 * per-cell margin_percent values (which would silently give a wrong number).
 */
function metricValue(metric: PivotMetric, totals: CellTotals): number | null {
  if (metric === "revenue") return totals.revenue;
  if (metric === "cogs") return totals.cogs;
  if (metric === "profit") return totals.profit;
  if (totals.revenue === 0) return null;
  return Math.round((totals.profit / totals.revenue) * 10000) / 100;
}

function addTotals(a: CellTotals, b: CellTotals): CellTotals {
  return { revenue: a.revenue + b.revenue, cogs: a.cogs + b.cogs, profit: a.profit + b.profit };
}

function columnKeyFor(row: PivotSourceRow, groupBy: PivotGroupBy): { key: string; groupLabel?: string } {
  if (groupBy === "location") {
    const label = row.location ?? UNSPECIFIED;
    return { key: label };
  }
  if (groupBy === "category") {
    const label = row.category_code ?? UNSPECIFIED;
    return { key: label };
  }
  const locLabel = row.location ?? UNSPECIFIED;
  const catLabel = row.category_code ?? UNSPECIFIED;
  return { key: `${locLabel}::${catLabel}`, groupLabel: locLabel };
}

/**
 * Pivots a flat (product, location?, category_code?) -> metrics list (from
 * report_sales_pivot) into a grid: rows = products (sorted by the selected
 * metric's total, descending), columns = distinct dimension value(s). In
 * "both" mode, columns are the FULL cross-product of every distinct location
 * seen x every distinct category seen (not just observed pairs), so a
 * product with no sales for a given combination shows a genuine gap (null)
 * rather than that column silently not existing.
 */
export function buildPivotGrid(rows: PivotSourceRow[], groupBy: PivotGroupBy, metric: PivotMetric): PivotGrid {
  const locations = groupBy !== "category" ? [...new Set(rows.map((r) => r.location ?? UNSPECIFIED))].sort() : [];
  const categories = groupBy !== "location" ? [...new Set(rows.map((r) => r.category_code ?? UNSPECIFIED))].sort() : [];

  let columns: PivotColumn[];
  let columnGroups: { label: string; span: number }[] | null = null;
  if (groupBy === "location") {
    columns = locations.map((loc) => ({ key: loc, label: loc }));
  } else if (groupBy === "category") {
    columns = categories.map((cat) => ({ key: cat, label: cat }));
  } else {
    columns = [];
    columnGroups = [];
    for (const loc of locations) {
      columnGroups.push({ label: loc, span: categories.length });
      for (const cat of categories) columns.push({ key: `${loc}::${cat}`, label: cat, groupLabel: loc });
    }
  }

  const byProduct = new Map<string, { productName: string; cellTotals: Map<string, CellTotals> }>();
  for (const row of rows) {
    const { key } = columnKeyFor(row, groupBy);
    const entry = byProduct.get(row.product_sku) ?? { productName: row.product_name ?? row.product_sku, cellTotals: new Map() };
    const existing = entry.cellTotals.get(key) ?? ZERO_TOTALS;
    entry.cellTotals.set(key, addTotals(existing, { revenue: row.revenue, cogs: row.cogs, profit: row.profit }));
    byProduct.set(row.product_sku, entry);
  }

  const pivotRows: PivotRow[] = [];
  const columnTotals = new Map<string, CellTotals>();
  let grandTotals = ZERO_TOTALS;

  for (const [productSku, entry] of byProduct) {
    const cells: Record<string, number | null> = {};
    let rowTotals = ZERO_TOTALS;
    for (const col of columns) {
      const t = entry.cellTotals.get(col.key);
      cells[col.key] = t ? metricValue(metric, t) : null;
      if (t) {
        rowTotals = addTotals(rowTotals, t);
        columnTotals.set(col.key, addTotals(columnTotals.get(col.key) ?? ZERO_TOTALS, t));
        grandTotals = addTotals(grandTotals, t);
      }
    }
    pivotRows.push({ productSku, productName: entry.productName, cells, total: metricValue(metric, rowTotals) });
  }

  pivotRows.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));

  const totals: Record<string, number | null> = {};
  for (const col of columns) totals[col.key] = metricValue(metric, columnTotals.get(col.key) ?? ZERO_TOTALS);

  return { columns, columnGroups, rows: pivotRows, totals, grandTotal: metricValue(metric, grandTotals) };
}
