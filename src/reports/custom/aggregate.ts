/**
 * Generic grouping engine for the custom report builder — deliberately NOT
 * the 2D pivot grid (reports/pivot.ts), which is hardcoded to exactly 2
 * dimensions and a fixed 5-metric column set. This groups facts rows by any
 * number of chosen dimensions into a flat table and sums any number of
 * chosen measures — the safety boundary is the DimensionDef/MeasureDef
 * whitelist each source defines (reports/custom/sources.ts), never a
 * user-supplied string reaching a query.
 */
export interface DimensionDef<Row> {
  key: string;
  label: string;
  /** Groups rows together — e.g. product SKU, not the display name, so two SKUs sharing a name don't merge. */
  getGroupKey: (row: Row) => string;
  /** What's shown/exported for the group — defaults to getGroupKey when a dimension has no separate display form. */
  getDisplayValue?: (row: Row) => string;
}

export interface MeasureDef<Row> {
  key: string;
  label: string;
  getValue: (row: Row) => number;
}

export interface CustomReportRow {
  dimensionValues: string[];
  measureValues: number[];
}

export interface CustomReportResult {
  rows: CustomReportRow[];
  totals: number[];
}

/**
 * Groups by the composite key of every chosen dimension (in order), summing
 * every chosen measure per group. An empty dimension list collapses
 * everything into a single grand-total row; an empty measure list still
 * groups, just with no summed columns.
 */
export function aggregateCustomReport<Row>(
  rows: Row[],
  dimensions: DimensionDef<Row>[],
  measures: MeasureDef<Row>[]
): CustomReportResult {
  const groups = new Map<string, { displayValues: string[]; measureSums: number[] }>();

  for (const row of rows) {
    const groupKeys = dimensions.map((d) => d.getGroupKey(row));
    const compositeKey = groupKeys.join("");

    let group = groups.get(compositeKey);
    if (!group) {
      const displayValues = dimensions.map((d) => (d.getDisplayValue ?? d.getGroupKey)(row));
      group = { displayValues, measureSums: measures.map(() => 0) };
      groups.set(compositeKey, group);
    }

    measures.forEach((m, i) => {
      group!.measureSums[i] += m.getValue(row);
    });
  }

  const resultRows: CustomReportRow[] = Array.from(groups.values()).map((g) => ({
    dimensionValues: g.displayValues,
    measureValues: g.measureSums,
  }));

  const totals = measures.map((_, i) => resultRows.reduce((sum, r) => sum + r.measureValues[i], 0));

  return { rows: resultRows, totals };
}
