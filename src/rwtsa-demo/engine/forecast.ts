/** Brief §5.2: weekly forecast = monthly average / 4.345. */
export const WEEKS_PER_MONTH = 4.345;

export type DemandForecast =
  | { readonly status: "ok"; readonly total: number; readonly count: number }
  | { readonly status: "insufficient"; readonly missingMonths: readonly string[] };

/**
 * Average demand over a window of months.
 *
 *  - A month with no valid observation (absent, or a blank cell) is MISSING. The forecast is then `insufficient`: no older
 *    month is substituted and nothing is invented.
 *  - A month the planner EXCLUDED is removed from both the demand total and the observation count (it is not replaced).
 *  - An explicit 0 is a valid observation.
 */
export function demandForecast(months: readonly string[], obs: ReadonlyMap<string, number | null>, excluded: ReadonlySet<string>): DemandForecast {
  const missing = months.filter((m) => !excluded.has(m) && (obs.get(m) ?? null) === null);
  if (missing.length > 0) return { status: "insufficient", missingMonths: missing };
  let total = 0;
  let count = 0;
  for (const m of months) {
    if (excluded.has(m)) continue;
    total += obs.get(m) as number;
    count += 1;
  }
  if (count === 0) return { status: "insufficient", missingMonths: [] };
  return { status: "ok", total, count };
}
