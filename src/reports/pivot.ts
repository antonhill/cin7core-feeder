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

interface RawTotals {
  quantity: number;
  revenue: number;
  cogs: number;
  profit: number;
}

/**
 * Every metric shown together per pivot cell — matches Cin7 Core's own
 * native pivot report (Qty/Invoice/COGS/Profit side by side under each
 * column group), rather than the single-metric-at-a-time design tried first.
 * Margin% is the one addition beyond Cin7's own columns, kept since it was
 * part of the original ask.
 */
export interface PivotCellValues {
  quantitySold: number;
  revenue: number;
  cogs: number;
  profit: number;
  marginPercent: number | null;
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
  cells: Record<string, PivotCellValues | null>;
  total: PivotCellValues;
}

export interface PivotGrid {
  columns: PivotColumn[];
  /** Top-level header groups (Location), non-null only in "both" mode. */
  columnGroups: { label: string; span: number }[] | null;
  rows: PivotRow[];
  totals: Record<string, PivotCellValues>;
  grandTotal: PivotCellValues;
}

const UNSPECIFIED = "(none)";
const ZERO_TOTALS: RawTotals = { quantity: 0, revenue: 0, cogs: 0, profit: 0 };

function addTotals(a: RawTotals, b: RawTotals): RawTotals {
  return { quantity: a.quantity + b.quantity, revenue: a.revenue + b.revenue, cogs: a.cogs + b.cogs, profit: a.profit + b.profit };
}

/** Margin% is never additive — always re-derived from summed revenue/profit, not from summing or averaging per-cell margins (which would silently be wrong). */
function toCellValues(totals: RawTotals): PivotCellValues {
  return {
    quantitySold: totals.quantity,
    revenue: totals.revenue,
    cogs: totals.cogs,
    profit: totals.profit,
    marginPercent: totals.revenue === 0 ? null : Math.round((totals.profit / totals.revenue) * 10000) / 100,
  };
}

function columnKeyFor(row: PivotSourceRow, groupBy: PivotGroupBy): string {
  if (groupBy === "location") return row.location ?? UNSPECIFIED;
  if (groupBy === "category") return row.category_code ?? UNSPECIFIED;
  return `${row.location ?? UNSPECIFIED}::${row.category_code ?? UNSPECIFIED}`;
}

/**
 * Pivots a flat (product, location?, category_code?) -> metrics list (from
 * report_sales_pivot) into a grid: rows = products (sorted by total revenue,
 * descending), columns = distinct dimension value(s), each cell carrying
 * every metric. In "both" mode, columns are the FULL cross-product of every
 * distinct location seen x every distinct category seen (not just observed
 * pairs), so a product with no sales for a given combination shows a genuine
 * gap (null) rather than that column silently not existing.
 */
export function buildPivotGrid(rows: PivotSourceRow[], groupBy: PivotGroupBy): PivotGrid {
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

  const byProduct = new Map<string, { productName: string; cellTotals: Map<string, RawTotals> }>();
  for (const row of rows) {
    const key = columnKeyFor(row, groupBy);
    const entry = byProduct.get(row.product_sku) ?? { productName: row.product_name ?? row.product_sku, cellTotals: new Map() };
    const existing = entry.cellTotals.get(key) ?? ZERO_TOTALS;
    entry.cellTotals.set(key, addTotals(existing, { quantity: row.quantity_sold, revenue: row.revenue, cogs: row.cogs, profit: row.profit }));
    byProduct.set(row.product_sku, entry);
  }

  const pivotRows: PivotRow[] = [];
  const columnTotals = new Map<string, RawTotals>();
  let grandTotals = ZERO_TOTALS;

  for (const [productSku, entry] of byProduct) {
    const cells: Record<string, PivotCellValues | null> = {};
    let rowTotals = ZERO_TOTALS;
    for (const col of columns) {
      const t = entry.cellTotals.get(col.key);
      cells[col.key] = t ? toCellValues(t) : null;
      if (t) {
        rowTotals = addTotals(rowTotals, t);
        columnTotals.set(col.key, addTotals(columnTotals.get(col.key) ?? ZERO_TOTALS, t));
        grandTotals = addTotals(grandTotals, t);
      }
    }
    pivotRows.push({ productSku, productName: entry.productName, cells, total: toCellValues(rowTotals) });
  }

  pivotRows.sort((a, b) => b.total.revenue - a.total.revenue);

  const totals: Record<string, PivotCellValues> = {};
  for (const col of columns) totals[col.key] = toCellValues(columnTotals.get(col.key) ?? ZERO_TOTALS);

  return { columns, columnGroups, rows: pivotRows, totals, grandTotal: toCellValues(grandTotals) };
}
