const ZAR_BASE_PRICE = 799;

/** Shown if the live rate fetch fails for any reason — the rate this was priced at when first set (2026-07), so it's a sane number even stale. */
const FALLBACK_USD_ESTIMATE = 49;

/** Pure — no I/O, easy to unit test independently of the network call. */
export function usdEstimateFromRate(zarPerUsd: number): number {
  return Math.round(ZAR_BASE_PRICE / zarPerUsd);
}

/**
 * Rounded USD equivalent of the real ZAR 799/month price, from a free,
 * keyless FX API — Lemon Squeezy's checkout auto-localizes the real ZAR
 * price to whatever currency a customer's browser suggests anyway (see
 * buildCheckoutUrl in src/lib/lemonsqueezy.ts), so this is always an
 * estimate for the marketing page, never the literal amount charged.
 * Cached a day at a time (Next's fetch data cache) since pricing copy
 * doesn't need to track FX moves any faster than that, and falls back to a
 * fixed estimate rather than ever failing the page render if the free API
 * is slow, down, or returns something unexpected.
 */
export async function getUsdPriceEstimate(): Promise<number> {
  try {
    const response = await fetch("https://open.er-api.com/v6/latest/USD", {
      next: { revalidate: 60 * 60 * 24 },
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return FALLBACK_USD_ESTIMATE;
    const body = (await response.json()) as { rates?: Record<string, number> };
    const zarPerUsd = body.rates?.ZAR;
    if (!zarPerUsd || zarPerUsd <= 0) return FALLBACK_USD_ESTIMATE;
    return usdEstimateFromRate(zarPerUsd);
  } catch {
    return FALLBACK_USD_ESTIMATE;
  }
}
