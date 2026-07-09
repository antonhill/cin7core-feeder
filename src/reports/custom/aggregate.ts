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

export interface SumMeasureDef<Row> {
  key: string;
  label: string;
  getValue: (row: Row) => number;
}

/**
 * A ratio (e.g. margin% = profit ÷ revenue) can't be summed row-by-row the
 * way a plain measure can — summing or averaging per-row percentages gives a
 * different (wrong) answer than the true ratio of the group's totals. Instead
 * this depends on other measures in the same source already being summed,
 * and computes the ratio from those sums once, per group (and again for the
 * grand total, from the grand-total sums — not by averaging group-level
 * ratios, which has the same Simpson's-paradox-style problem).
 */
export interface RatioMeasureDef {
  key: string;
  label: string;
  /** Keys of other measures in this source whose sums this needs — resolved even if the user didn't select them as their own output column. */
  dependsOn: string[];
  /** Returns null (not 0 or NaN) when the ratio can't be meaningfully computed, e.g. a zero denominator. */
  compute: (sums: Record<string, number>) => number | null;
}

export type MeasureDef<Row> = SumMeasureDef<Row> | RatioMeasureDef;

function isRatioMeasure<Row>(m: MeasureDef<Row>): m is RatioMeasureDef {
  return "compute" in m;
}

export interface CustomReportRow {
  dimensionValues: string[];
  measureValues: (number | null)[];
}

export interface CustomReportResult {
  rows: CustomReportRow[];
  totals: (number | null)[];
}

/**
 * Groups by the composite key of every chosen dimension (in order). Every
 * sum-type measure in `allMeasures` (not just the ones the user selected) is
 * summed per group and for the grand total, so a selected ratio measure can
 * always resolve its dependencies regardless of which columns are actually
 * shown — `selectedMeasureKeys` then picks (and orders) which columns come
 * back, sum or ratio alike. An empty dimension list collapses everything
 * into a single grand-total row; an empty measure-key list still groups,
 * just with no measure columns.
 */
export function aggregateCustomReport<Row>(
  rows: Row[],
  dimensions: DimensionDef<Row>[],
  allMeasures: MeasureDef<Row>[],
  selectedMeasureKeys: string[]
): CustomReportResult {
  const sumMeasures = allMeasures.filter((m): m is SumMeasureDef<Row> => !isRatioMeasure(m));
  const ratioMeasures = allMeasures.filter(isRatioMeasure);

  const groups = new Map<string, { displayValues: string[]; sums: Record<string, number> }>();
  const grandTotalSums: Record<string, number> = {};
  sumMeasures.forEach((m) => {
    grandTotalSums[m.key] = 0;
  });

  for (const row of rows) {
    const groupKeys = dimensions.map((d) => d.getGroupKey(row));
    const compositeKey = groupKeys.join("");

    let group = groups.get(compositeKey);
    if (!group) {
      const displayValues = dimensions.map((d) => (d.getDisplayValue ?? d.getGroupKey)(row));
      const sums: Record<string, number> = {};
      sumMeasures.forEach((m) => {
        sums[m.key] = 0;
      });
      group = { displayValues, sums };
      groups.set(compositeKey, group);
    }

    sumMeasures.forEach((m) => {
      const value = m.getValue(row);
      group!.sums[m.key] += value;
      grandTotalSums[m.key] += value;
    });
  }

  function resolveSelected(sums: Record<string, number>): (number | null)[] {
    return selectedMeasureKeys.map((key) => {
      const ratio = ratioMeasures.find((m) => m.key === key);
      if (ratio) return ratio.compute(sums);
      return sums[key] ?? 0;
    });
  }

  const resultRows: CustomReportRow[] = Array.from(groups.values()).map((g) => ({
    dimensionValues: g.displayValues,
    measureValues: resolveSelected(g.sums),
  }));

  const totals = resolveSelected(grandTotalSums);

  return { rows: resultRows, totals };
}
