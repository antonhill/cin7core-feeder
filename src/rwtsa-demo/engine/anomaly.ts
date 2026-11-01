export interface Observation {
  readonly month: string;
  readonly qty: number | null;
}

export interface AnomalyConfig {
  /** Flag when the observation exceeds this multiple of the SKU median ... */
  readonly multiple: number;
  /** ... AND exceeds this absolute number of units. Both must be exceeded (strictly). */
  readonly floor: number;
}

export interface FlaggedObservation {
  readonly month: string;
  readonly qty: number;
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Brief §5: flag a monthly observation that exceeds BOTH a multiple of the SKU's median AND an absolute floor.
 * The median is taken over every VALID observation in the supplied history (blank months are not observations), and is
 * independent of any planner exclusion so that a flag never disappears just because it was reviewed.
 */
export function detectAnomalies(series: readonly Observation[], cfg: AnomalyConfig): { readonly median: number | null; readonly flagged: readonly FlaggedObservation[] } {
  const valid = series.filter((o): o is { month: string; qty: number } => o.qty !== null);
  const med = median(valid.map((o) => o.qty));
  if (med === null) return { median: null, flagged: [] };
  const flagged = valid.filter((o) => o.qty > cfg.multiple * med && o.qty > cfg.floor).map((o) => ({ month: o.month, qty: o.qty }));
  return { median: med, flagged };
}
