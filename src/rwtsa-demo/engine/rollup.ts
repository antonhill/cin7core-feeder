import type { AnomalyRow, SkuResult, StyleResult } from "./types";

/**
 * Style-level roll-up. Quantities are SUMS of the underlying SKU quantities, so they reconcile exactly. Sizes are never netted
 * against each other (a surplus in one size does not hide a shortage in another): a style's first breach is its earliest SKU
 * breach, and its proposed order is the sum of the SKU proposals. Ratios are recomputed from aggregated numerators and
 * denominators, never summed or averaged.
 */
export function rollUpStyles(skus: readonly SkuResult[], anomalies: readonly AnomalyRow[], horizon: number): StyleResult[] {
  const order: string[] = [];
  const groups = new Map<string, SkuResult[]>();
  for (const s of skus) {
    if (!groups.has(s.styleCode)) {
      groups.set(s.styleCode, []);
      order.push(s.styleCode);
    }
    (groups.get(s.styleCode) as SkuResult[]).push(s);
  }
  return order.map((styleCode) => {
    const m = groups.get(styleCode) as SkuResult[];
    const withBalances = m.filter((s) => s.balances.length === horizon);
    const balances = Array.from({ length: horizon }, (_, w) => withBalances.reduce((a, s) => a + s.balances[w], 0));
    const forecastable = m.filter((s) => s.monthlyForecast !== null && s.available !== null);
    const num = forecastable.reduce((a, s) => a + (s.available as number), 0);
    const den = forecastable.reduce((a, s) => a + (s.monthlyForecast as number), 0);
    const breaches = m.filter((s) => s.firstBreachWeek !== null).map((s) => s.firstBreachWeek as number);
    const mine = anomalies.filter((a) => a.styleCode === styleCode);
    return {
      styleCode,
      skuCount: m.length,
      available: m.reduce((a, s) => a + (s.available ?? 0), 0),
      inboundTotal: m.reduce((a, s) => a + s.inboundTotal, 0),
      monthlyForecast: m.reduce((a, s) => a + (s.monthlyForecast ?? 0), 0),
      weeklyForecast: m.reduce((a, s) => a + (s.weeklyForecast ?? 0), 0),
      minLevel: withBalances.reduce((a, s) => a + (s.minLevel ?? 0), 0),
      balances,
      firstBreachWeek: breaches.length === 0 ? null : Math.min(...breaches),
      shortfall: m.reduce((a, s) => a + s.shortfall, 0),
      proposedOrder: m.reduce((a, s) => a + s.proposedOrder, 0),
      monthsOfCover: den > 0 ? Math.max(0, num / den) : null,
      shortageSkus: m.filter((s) => !s.tenderExempt && s.shortfall > 0).length,
      skusWithoutForecast: m.filter((s) => s.forecast.status === "insufficient").length,
      tenderExemptSkus: m.filter((s) => s.tenderExempt).length,
      anomaliesToReview: mine.filter((a) => a.inWindow && !a.excluded).length,
      anomaliesExcluded: mine.filter((a) => a.excluded).length,
    };
  });
}
